// A GitHub-compatible git forge in one process: git smart HTTP (protocol v2 + v0), the REST v3
// surface, GraphQL v4 and an MCP endpoint, all over one in-memory store. Node standard library only.
//
// The store is the suite's world: repositories are created through REST, commits arrive through
// contents writes and git pushes, and every surface (REST, GraphQL, MCP, git) reads and writes the
// same objects, so an issue opened over MCP is the issue REST lists, and a branch pushed over git is
// the branch a pull request names.
//
// Identity: the bearer token names one login. That login is a pure function of the contest's fixed
// scenario seed (the suite generates its cast from the same seed), so it is derived here with the
// same published generator instead of being configured.
//
// Time is a logical clock (a counter over a fixed epoch), never the wall clock: two runs of the
// same request sequence produce the same timestamps, the same ordering and the same bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// The token owner's identity, derived from the contest's fixed scenario seed.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*, the scenario generator's stream (only the operations user generation uses). */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The scenario's cast, regenerated: users[0] owns the token, users[2] is the stranger. */
function deriveUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = deriveUsers();
const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;

// ---------------------------------------------------------------------------------------------
// The logical clock: a creation sequence over a fixed epoch (2025-01-01T00:00:00Z).

const EPOCH_BASE_SEC = 1_735_689_600;
let clockSeq = 0;

function tick(): number {
  clockSeq += 1;
  return EPOCH_BASE_SEC + clockSeq;
}

function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** The git identity line the forge commits under (the token owner's). */
function identityLine(sec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
}

// ---------------------------------------------------------------------------------------------
// The git object store: content-addressed, shared by every repository (reachability, not the
// store, decides what a repository's fetch may carry).

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const objectStore = new Map<string, GitObject>();
const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

function storeObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objectStore.has(oid)) objectStore.set(oid, { type, data });
  return oid;
}

function getObject(oid: string): GitObject | undefined {
  return objectStore.get(oid);
}

// ---------------------------------------------------------------------------------------------
// Commits and trees.

interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommitData(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${author}\ncommitter ${committer}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, directories as if the name ended in '/'. */
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeEntryCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Follow tag objects to the commit they name (null when the chain ends elsewhere). */
function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = getObject(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// File maps: a commit's tree flattened to path -> blob, the shape the contents API and pull
// request diffs work in. Cached per commit; the cache is small and self-clearing.

interface FileEntry {
  oid: string;
  size: number;
}

const fileMapCache = new Map<string, Map<string, FileEntry>>();

function fileMapOf(commitOid: string): Map<string, FileEntry> {
  const cached = fileMapCache.get(commitOid);
  if (cached !== undefined) return cached;
  const map = new Map<string, FileEntry>();
  const commit = getObject(commitOid);
  if (commit !== undefined && commit.type === 'commit') {
    const walk = (treeOid: string, prefix: string): void => {
      const tree = getObject(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else {
          const blob = getObject(entry.oid);
          map.set(`${prefix}${entry.name}`, { oid: entry.oid, size: blob === undefined ? 0 : blob.data.length });
        }
      }
    };
    walk(parseCommit(commit.data).tree, '');
  }
  if (fileMapCache.size > 4096) fileMapCache.clear();
  fileMapCache.set(commitOid, map);
  return map;
}

/** Build (and store) the tree chain for a file map; returns the root tree's id. */
function treeFromFileMap(map: ReadonlyMap<string, FileEntry>): string {
  interface Dir {
    files: Map<string, FileEntry>;
    dirs: Map<string, Dir>;
  }
  const make = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of map) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: '100644', name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject('tree', buildTreeData(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// History walks.

/** Every commit reachable from `tip` (inclusive), parents followed. */
function ancestorsOf(tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits (breadth-first from `b` against `a`'s ancestry). */
function mergeBaseOf(a: string, b: string): string | null {
  const ancestors = ancestorsOf(a);
  if (ancestors.has(b)) return b;
  const seen = new Set<string>([b]);
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestors.has(oid)) return oid;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Every object reachable from a commit: the commit chain, their trees and blobs, tags peeled in. */
function closureOf(tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Repositories and their contents: the one store every surface shares.

interface Label {
  name: string;
  color: string;
  description: string;
}

interface IssueComment {
  id: number;
  body: string;
  seq: number;
  createdSec: number;
  updatedSec: number;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  createdSec: number;
  updatedSec: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headShaSnapshot: string;
  mergeCommitSha: string | null;
  seq: number;
  createdSec: number;
  updatedSec: number;
  mergedSec: number | null;
}

interface Repo {
  id: number;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdSec: number;
  updatedSec: number;
}

/** Every repository belongs to the token's login; the map is keyed by repository name. */
const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;

function headRefOf(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function createRepo(name: string, priv: boolean, description: string): Repo {
  const sec = tick();
  const repo: Repo = {
    id: nextRepoId,
    name,
    description,
    priv,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSec: sec,
    updatedSec: sec,
  };
  nextRepoId += 1;
  repos.set(name, repo);
  return repo;
}

/** Commit a new file map on a branch: the contents API's write, and the merge's landing. */
function commitFileMap(repo: Repo, branch: string, map: Map<string, FileEntry>, message: string): string {
  const tree = treeFromFileMap(map);
  const parent = branchTip(repo, branch);
  const sec = tick();
  const identity = identityLine(sec);
  const data = buildCommitData(tree, parent === undefined ? [] : [parent], identity, identity, message.endsWith('\n') ? message : `${message}\n`);
  const oid = storeObject('commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updatedSec = sec;
  return oid;
}

// ---------------------------------------------------------------------------------------------
// Pull request diffs and merges, over file maps.

interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  before: FileEntry | null;
  after: FileEntry | null;
}

function diffFileMaps(before: ReadonlyMap<string, FileEntry>, after: ReadonlyMap<string, FileEntry>): FileDiff[] {
  const diffs: FileDiff[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined) diffs.push({ path, status: 'added', before: null, after: entry });
    else if (old.oid !== entry.oid) diffs.push({ path, status: 'modified', before: old, after: entry });
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) diffs.push({ path, status: 'removed', before: entry, after: null });
  }
  diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return diffs;
}

function blobText(oid: string | undefined): string {
  if (oid === undefined) return '';
  const object = getObject(oid);
  return object === undefined ? '' : object.data.toString('utf8');
}

/** Line-level additions/deletions between two texts (an LCS over lines; inputs here are small). */
function lineDiffCounts(beforeText: string, afterText: string): { additions: number; deletions: number } {
  const a = beforeText === '' ? [] : beforeText.split('\n');
  const b = afterText === '' ? [] : afterText.split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Uint32Array((a.length + 1) * (b.length + 1));
  const width = b.length + 1;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? (dp[(i + 1) * width + j + 1] as number) + 1 : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

interface MergeAnalysis {
  base: string | null;
  headTip: string;
  baseTip: string;
  diffs: FileDiff[];
  conflict: boolean;
}

/** Analyse a pull request against the current base tip: its changed files and whether it conflicts. */
function analysePull(repo: Repo, pull: Pull): MergeAnalysis | null {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaSnapshot;
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined || headTip === undefined || getObject(headTip) === undefined) return null;
  const base = mergeBaseOf(baseTip, headTip);
  const baseMap = base === null ? new Map<string, FileEntry>() : fileMapOf(base);
  const headMap = fileMapOf(headTip);
  const baseTipMap = fileMapOf(baseTip);
  const diffs = diffFileMaps(baseMap, headMap);
  const baseDiffs = diffFileMaps(baseMap, baseTipMap);
  const baseChanged = new Map(baseDiffs.map((diff) => [diff.path, diff.after?.oid ?? null]));
  let conflict = false;
  for (const diff of diffs) {
    if (!baseChanged.has(diff.path)) continue;
    const baseResult = baseChanged.get(diff.path) ?? null;
    const headResult = diff.after?.oid ?? null;
    if (baseResult !== headResult) conflict = true;
  }
  return { base, headTip, baseTip, diffs, conflict };
}

/** Squash-merge a pull request onto its base branch; the caller has checked it does not conflict. */
function squashMerge(repo: Repo, pull: Pull, analysis: MergeAnalysis): string {
  const baseTipMap = new Map(fileMapOf(analysis.baseTip));
  for (const diff of analysis.diffs) {
    if (diff.after === null) baseTipMap.delete(diff.path);
    else baseTipMap.set(diff.path, diff.after);
  }
  const message = `${pull.title}\n\nSquashed pull request #${pull.number}\n`;
  const sha = commitFileMap(repo, pull.baseRef, baseTipMap, message);
  const sec = tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSec = sec;
  pull.updatedSec = sec;
  pull.mergeCommitSha = sha;
  return sha;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines and packfiles.

const PKT_MAX_PAYLOAD = 65_516;

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktParse {
  packets: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }>;
  rest: Buffer;
  ok: boolean;
}

/** Decode every complete pkt-line in `bytes`; `rest` is what follows the terminating flush. */
function parsePktLines(bytes: Buffer): PktParse {
  const packets: PktParse['packets'] = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const header = bytes.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { packets, rest: bytes.subarray(pos), ok: false };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: bytes.subarray(pos + 4), ok: true };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > bytes.length) return { packets, rest: bytes.subarray(pos), ok: false };
    packets.push({ kind: 'data', payload: bytes.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: bytes.subarray(pos), ok: pos === bytes.length };
}

/** One object's pack entry: the type/size varint header and its zlib stream. */
function packEntry(type: GitObjectType, data: Buffer): Buffer {
  const typeCode = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  let size = data.length;
  const head: number[] = [];
  let first = size & 0x0f;
  size >>= 4;
  if (size > 0) first |= 0x80;
  head.push((typeCode << 4) | first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    head.push(byte);
  }
  return Buffer.concat([Buffer.from(head), deflateSync(data)]);
}

/** A whole packfile (version 2, plain objects, no deltas) with its SHA-1 trailer. */
function buildPack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = getObject(oid);
    if (object !== undefined) parts.push(packEntry(object.type, object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `pos`; returns the data and the offset just past the stream. */
function inflateOne(bytes: Buffer, pos: number): { data: Buffer; next: number } {
  const rest = bytes.subarray(pos);
  const data = inflateSync(rest);
  // inflateSync ignores trailing bytes; binary-search the shortest prefix that yields this data.
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const attempt = inflateSync(rest.subarray(0, mid));
      ok = attempt.length === data.length && attempt.equals(data);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data, next: pos + lo };
}

/** Apply a git delta to its base. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { offset |= (delta[pos] as number) << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { size |= (delta[pos] as number) << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return result;
}

interface PackRead {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
}

/** Read a packfile the client sent (plain objects, plus ofs/ref deltas resolved against the store). */
function readPack(bytes: Buffer): PackRead {
  if (bytes.length < 12 + 20 || bytes.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = bytes.readUInt32BE(8);
  const trailer = bytes.subarray(bytes.length - 20);
  const digest = createHash('sha1').update(bytes.subarray(0, bytes.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let pos = 12;
  const raw: Array<{ typeCode: number; data: Buffer; baseOffset?: number; baseOid?: string; start: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = bytes[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = bytes[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let b = bytes[pos] as number;
      pos += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = bytes[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = offset;
    } else if (typeCode === 7) {
      baseOid = bytes.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateOne(bytes, pos);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    pos = inflated.next;
    raw.push({ typeCode, data: inflated.data, baseOffset, baseOid, start });
  }
  const byStart = new Map(raw.map((entry) => [entry.start, entry]));
  const typeNames: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolve = (entry: (typeof raw)[number]): { type: GitObjectType; data: Buffer } => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byStart.get(entry.start - (entry.baseOffset as number));
        if (baseEntry !== undefined) base = resolve(baseEntry);
      } else {
        const stored = getObject(entry.baseOid as string);
        if (stored !== undefined) base = stored;
        else {
          const inPack = raw.find((candidate) => candidate.typeCode >= 1 && candidate.typeCode <= 4 && hashObject(typeNames[candidate.typeCode] as GitObjectType, candidate.data) === entry.baseOid);
          if (inPack !== undefined) base = resolve(inPack);
        }
      }
      if (base === undefined) throw new Error('delta base missing');
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    const type = typeNames[entry.typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
    return { type, data: entry.data };
  };
  return { objects: raw.map(resolve) };
}

// ---------------------------------------------------------------------------------------------
// Serializers: the REST view of the store, plus the opaque global ids GraphQL round-trips.

function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.split(':');
    if (split.length < 2) return null;
    return { kind: split[0] as string, parts: split.slice(1) };
  } catch {
    return null;
  }
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.login),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoJson(repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}/api/v3`;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: userJson(),
    private: repo.priv,
    description: repo.description,
    fork: false,
    html_url: `http://${host}/${VIEWER.login}/${repo.name}`,
    clone_url: `http://${host}/${VIEWER.login}/${repo.name}.git`,
    url: `${base}/repos/${VIEWER.login}/${repo.name}`,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.updatedSec),
    pushed_at: isoOf(repo.updatedSec),
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: Number(fnv1a64(label.name) % 1_000_000_000n),
    node_id: globalId('Label', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `http://placeholder/api/v3/repos/${VIEWER.login}/${repo.name}`;
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: userJson(),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedSec) : null,
    url: `${base}/issues/${issue.number}`,
    html_url: `${base}/issues/${issue.number}`,
    repository_url: `http://placeholder/api/v3/repos/${VIEWER.login}/${repo.name}`,
  };
}

/** Comment lookup by global id, for GraphQL's node() (comments are also reached via their issue). */
const commentIndex = new Map<number, { repo: Repo; issue: Issue }>();

function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.updatedSec),
  };
}

function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const sec = tick();
  const issue: Issue = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: clockSeq,
    createdSec: sec,
    updatedSec: sec,
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function addComment(repo: Repo, issue: Issue, body: string): IssueComment {
  const sec = tick();
  const comment: IssueComment = { id: nextCommentId, body, seq: clockSeq, createdSec: sec, updatedSec: sec };
  nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedSec = sec;
  commentIndex.set(comment.id, { repo, issue });
  return comment;
}

function pullJson(repo: Repo, pull: Pull, host: string): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaSnapshot;
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${VIEWER.login}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo, host),
  });
  let mergeable: boolean | null = null;
  if (pull.state === 'open') {
    const analysis = analysePull(repo, pull);
    mergeable = analysis === null ? null : !analysis.conflict;
  }
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : isoOf(pull.mergedSec),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    draft: false,
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    html_url: `http://${host}/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    url: `http://${host}/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
  };
}

function createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
  const sec = tick();
  const pull: Pull = {
    id: nextPullId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headShaSnapshot: branchTip(repo, headRef) ?? '',
    mergeCommitSha: null,
    seq: clockSeq,
    createdSec: sec,
    updatedSec: sec,
    mergedSec: null,
  };
  nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function commitJson(sha: string): Record<string, unknown> {
  const object = getObject(sha);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: '', email: '', date: isoOf(EPOCH_BASE_SEC) };
    return { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
  };
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: person(info.author),
      committer: person(info.committer),
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing.

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${SHOP_TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 96 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringFieldOf(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/** Parse a JSON request body; answers false (after sending a 400) when it is not valid JSON. */
function parseBodyOr400(res: ServerResponse, raw: Buffer): JsonObject | null {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
  const object = asObject(parsed);
  if (object === null) {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
  return object;
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(params: URLSearchParams): Page {
  const perPageRaw = Number(params.get('per_page') ?? '30');
  const pageRaw = Number(params.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page): T[] {
  return items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
}

/** A GitHub Link header for the page after this one, when there is one. */
function linkHeader(host: string, path: string, params: URLSearchParams, page: Page, total: number): Record<string, string> {
  const totalPages = Math.max(1, Math.ceil(total / page.perPage));
  if (page.page >= totalPages) return {};
  const next = new URLSearchParams(params);
  next.set('per_page', String(page.perPage));
  next.set('page', String(page.page + 1));
  const last = new URLSearchParams(params);
  last.set('per_page', String(page.perPage));
  last.set('page', String(totalPages));
  const value = `<http://${host}${path}?${next.toString()}>; rel="next", <http://${host}${path}?${last.toString()}>; rel="last"`;
  return { link: value };
}

// ---------------------------------------------------------------------------------------------
// REST v3 routes (under /api/v3). Every repository lives under the token owner's login; a
// repository addressed under any other owner is a 404, never a 403 (GitHub hides what the token
// cannot see).

interface RestContext {
  res: ServerResponse;
  host: string;
  method: string;
  params: URLSearchParams;
  raw: Buffer;
}

function repoNotFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

/** The repository a /repos/{owner}/{name} path names, or null after answering 404. */
function addressedRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    repoNotFound(res);
    return null;
  }
  const repo = repos.get(name);
  if (repo === undefined) {
    repoNotFound(res);
    return null;
  }
  return repo;
}

function handleRestRoot(ctx: RestContext): void {
  const base = `http://${ctx.host}/api/v3`;
  sendJson(ctx.res, 200, {
    current_user_url: `${base}/user`,
    current_user_repositories_url: `${base}/user/repos`,
    repository_url: `${base}/repos/{owner}/{repo}`,
    issue_search_url: `${base}/search/issues?q={query}`,
    label_search_url: `${base}/search/labels?q={query}&repository_id={repository_id}`,
    emojis_url: `${base}/emojis`,
    events_url: `${base}/events`,
    feeds_url: `${base}/feeds`,
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

function handleRestMeta(ctx: RestContext): void {
  sendJson(ctx.res, 200, {
    installed_version: '1.0.0-forge',
    verifiable_password_authentication: false,
    ssh_key_fingerprints: {},
    hooks: [],
  });
}

function handleCreateRepo(ctx: RestContext): void {
  const body = parseBodyOr400(ctx.res, ctx.raw);
  if (body === null) return;
  const name = stringFieldOf(body, 'name');
  if (name === undefined || name === '' || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    sendJson(ctx.res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] });
    return;
  }
  if (repos.has(name)) {
    sendJson(ctx.res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
    return;
  }
  const priv = body.private === true;
  const description = stringFieldOf(body, 'description') ?? '';
  const repo = createRepo(name, priv, description);
  if (body.auto_init === true) {
    const sec = tick();
    const blob = storeObject('blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const map = new Map<string, FileEntry>([['README.md', { oid: blob, size: 3 + name.length }]]);
    commitFileMap(repo, repo.defaultBranch, map, 'Initial commit');
    void sec;
  }
  sendJson(ctx.res, 201, repoJson(repo, ctx.host));
}

function handleListUserRepos(ctx: RestContext): void {
  const page = pageOf(ctx.params);
  const all = [...repos.values()].sort((a, b) => a.id - b.id);
  const headers = linkHeader(ctx.host, '/api/v3/user/repos', ctx.params, page, all.length);
  sendJson(ctx.res, 200, paginate(all, page).map((repo) => repoJson(repo, ctx.host)), headers);
}

function handleRepo(ctx: RestContext, repo: Repo): void {
  if (ctx.method === 'GET') {
    sendJson(ctx.res, 200, repoJson(repo, ctx.host));
    return;
  }
  if (ctx.method === 'DELETE') {
    repos.delete(repo.name);
    ctx.res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    ctx.res.end();
    return;
  }
  if (ctx.method === 'PATCH') {
    const body = parseBodyOr400(ctx.res, ctx.raw);
    if (body === null) return;
    const description = stringFieldOf(body, 'description');
    if (description !== undefined) repo.description = description;
    if (typeof body.private === 'boolean') repo.priv = body.private;
    const newName = stringFieldOf(body, 'name');
    if (newName !== undefined && newName !== repo.name && newName !== '' && !repos.has(newName)) {
      repos.delete(repo.name);
      repo.name = newName;
      repos.set(newName, repo);
    }
    repo.updatedSec = tick();
    sendJson(ctx.res, 200, repoJson(repo, ctx.host));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

function handleCreateRef(ctx: RestContext, repo: Repo): void {
  const body = parseBodyOr400(ctx.res, ctx.raw);
  if (body === null) return;
  const ref = stringFieldOf(body, 'ref');
  const sha = stringFieldOf(body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
    sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', message: 'ref and sha are required' }] });
    return;
  }
  const object = getObject(sha);
  if (object === undefined) {
    sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'sha is not a known object' }] });
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', message: 'Reference already exists' }] });
    return;
  }
  repo.refs.set(ref, sha);
  repo.updatedSec = tick();
  sendJson(ctx.res, 201, { ref, node_id: globalId('Ref', ref), object: { sha, type: object.type } });
}

function handleGetRef(ctx: RestContext, repo: Repo, refPath: string): void {
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  const object = getObject(sha);
  sendJson(ctx.res, 200, { ref, node_id: globalId('Ref', ref), object: { sha, type: object === undefined ? 'commit' : object.type } });
}

function handleBranches(ctx: RestContext, repo: Repo, branchPath: string | null): void {
  if (branchPath === null) {
    const list: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      list.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    list.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    sendJson(ctx.res, 200, list);
    return;
  }
  const sha = branchTip(repo, branchPath);
  if (sha === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, { name: branchPath, commit: { sha }, protected: false });
}

function handleCommits(ctx: RestContext, repo: Repo): void {
  const page = pageOf(ctx.params);
  const shaParam = ctx.params.get('sha');
  let tip: string | undefined;
  if (shaParam === null || shaParam === '') tip = branchTip(repo, repo.defaultBranch);
  else if (branchTip(repo, shaParam) !== undefined) tip = branchTip(repo, shaParam);
  else if (getObject(shaParam) !== undefined && (getObject(shaParam) as GitObject).type === 'commit') tip = shaParam;
  else if (repo.refs.get(shaParam) !== undefined) tip = repo.refs.get(shaParam);
  if (tip === undefined) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') return;
    seen.add(oid);
    ordered.push(oid);
    for (const parent of parseCommit(object.data).parents) walk(parent);
  };
  walk(tip);
  sendJson(ctx.res, 200, paginate(ordered, page).map((sha) => commitJson(sha)));
}

/** Resolve a contents ref parameter to a commit: a branch name, else a commit id. */
function resolveRefCommit(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const tip = branchTip(repo, ref);
  if (tip !== undefined) return tip;
  const object = getObject(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return undefined;
}

/** The immediate entries of one directory of a commit's tree (real tree/blob ids). */
function listTreeAt(commitOid: string, dirPath: string): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; size: number }> | null {
  const commit = getObject(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const tree = getObject(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      treeOid = entry.oid;
    }
  }
  const tree = getObject(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : getObject(entry.oid);
    return {
      name: entry.name,
      path: `${prefix}${entry.name}`,
      type: isDir ? 'dir' as const : 'file' as const,
      oid: entry.oid,
      size: blob === undefined ? 0 : blob.data.length,
    };
  });
}

function handleGetContents(ctx: RestContext, repo: Repo, path: string): void {
  const commit = resolveRefCommit(repo, ctx.params.get('ref'));
  if (commit === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  const map = fileMapOf(commit);
  const entry = path === '' ? undefined : map.get(path);
  if (entry !== undefined) {
    const blob = getObject(entry.oid);
    const content = blob === undefined ? '' : blob.data.toString('base64');
    const name = path.slice(path.lastIndexOf('/') + 1);
    sendJson(ctx.res, 200, {
      type: 'file',
      encoding: 'base64',
      content,
      name,
      path,
      sha: entry.oid,
      size: entry.size,
    });
    return;
  }
  const listing = listTreeAt(commit, path);
  if (listing === null) {
    repoNotFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, listing.map((item) => ({
    type: item.type,
    name: item.name,
    path: item.path,
    sha: item.oid,
    size: item.type === 'file' ? item.size : 0,
  })));
}

/** Write one file through the contents API; the branch forks from the default branch when new. */
function writeContent(repo: Repo, branch: string, path: string, data: Buffer, message: string, sha: string | undefined): { status: number; commitSha?: string; blobSha?: string; error?: string } {
  let tip = branchTip(repo, branch);
  if (tip === undefined && branch !== repo.defaultBranch) {
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (defaultTip !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const map = tip === undefined ? new Map<string, FileEntry>() : new Map(fileMapOf(tip));
  const existing = map.get(path);
  if (existing !== undefined) {
    if (sha === undefined) return { status: 422, error: 'sha is required when updating an existing file' };
    if (sha !== existing.oid) return { status: 409, error: 'sha does not match the current file' };
  }
  const blobSha = storeObject('blob', data);
  map.set(path, { oid: blobSha, size: data.length });
  const commitSha = commitFileMap(repo, branch, map, message);
  return { status: existing === undefined ? 201 : 200, commitSha, blobSha };
}

function handlePutContents(ctx: RestContext, repo: Repo, path: string): void {
  const body = parseBodyOr400(ctx.res, ctx.raw);
  if (body === null) return;
  const message = stringFieldOf(body, 'message');
  const content = stringFieldOf(body, 'content');
  if (message === undefined || content === undefined || path === '') {
    sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', code: 'custom', message: 'message and content are required' }] });
    return;
  }
  const branch = stringFieldOf(body, 'branch') ?? repo.defaultBranch;
  const sha = stringFieldOf(body, 'sha');
  const data = Buffer.from(content, 'base64');
  const result = writeContent(repo, branch, path, data, message, sha);
  if (result.error !== undefined || result.commitSha === undefined || result.blobSha === undefined) {
    sendJson(ctx.res, result.status, { message: result.error ?? 'Validation Failed' });
    return;
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  sendJson(ctx.res, result.status, {
    content: { name, path, sha: result.blobSha, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitSha },
  });
}

function handleDeleteContents(ctx: RestContext, repo: Repo, path: string): void {
  const body = parseBodyOr400(ctx.res, ctx.raw);
  if (body === null) return;
  const message = stringFieldOf(body, 'message');
  const sha = stringFieldOf(body, 'sha');
  const branch = stringFieldOf(body, 'branch') ?? repo.defaultBranch;
  if (message === undefined || sha === undefined) {
    sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', code: 'custom', message: 'message and sha are required' }] });
    return;
  }
  const tip = branchTip(repo, branch);
  if (tip === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  const map = new Map(fileMapOf(tip));
  const existing = map.get(path);
  if (existing === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  if (existing.oid !== sha) {
    sendJson(ctx.res, 409, { message: 'sha does not match the current file' });
    return;
  }
  map.delete(path);
  const commitSha = commitFileMap(repo, branch, map, message);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commitSha } });
}

function handleLabels(ctx: RestContext, repo: Repo): void {
  if (ctx.method === 'GET') {
    sendJson(ctx.res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
    return;
  }
  if (ctx.method === 'POST') {
    const body = parseBodyOr400(ctx.res, ctx.raw);
    if (body === null) return;
    const name = stringFieldOf(body, 'name');
    if (name === undefined || name === '') {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'custom', field: 'name', message: 'name is required' }] });
      return;
    }
    if (repo.labels.has(name)) {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name', message: 'name already exists' }] });
      return;
    }
    const label: Label = {
      name,
      color: (stringFieldOf(body, 'color') ?? 'ededed').replace(/^#/, ''),
      description: stringFieldOf(body, 'description') ?? '',
    };
    repo.labels.set(name, label);
    sendJson(ctx.res, 201, labelJson(label));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

/** Label names from a request body: strings, or objects carrying a name. */
function labelNamesOf(body: JsonObject): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else {
      const object = asObject(entry);
      if (object !== null && typeof object.name === 'string') names.push(object.name);
    }
  }
  return names;
}

function handleIssues(ctx: RestContext, repo: Repo): void {
  if (ctx.method === 'GET') {
    const page = pageOf(ctx.params);
    const state = ctx.params.get('state') ?? 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    const direction = ctx.params.get('direction') ?? 'desc';
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    sendJson(ctx.res, 200, paginate(issues, page).map((issue) => issueJson(repo, issue)));
    return;
  }
  if (ctx.method === 'POST') {
    const body = parseBodyOr400(ctx.res, ctx.raw);
    if (body === null) return;
    const title = stringFieldOf(body, 'title');
    if (title === undefined || title === '') {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'title', message: 'title is required' }] });
      return;
    }
    const labels = labelNamesOf(body) ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${name}" does not exist` }] });
        return;
      }
    }
    const issue = createIssue(repo, title, stringFieldOf(body, 'body') ?? '', labels);
    sendJson(ctx.res, 201, issueJson(repo, issue));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

function handleIssue(ctx: RestContext, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  if (ctx.method === 'GET') {
    sendJson(ctx.res, 200, issueJson(repo, issue));
    return;
  }
  if (ctx.method === 'PATCH') {
    const body = parseBodyOr400(ctx.res, ctx.raw);
    if (body === null) return;
    const title = stringFieldOf(body, 'title');
    if (title !== undefined) issue.title = title;
    const text = stringFieldOf(body, 'body');
    if (text !== undefined) issue.body = text;
    const state = stringFieldOf(body, 'state');
    if (state === 'open' || state === 'closed') issue.state = state;
    const labels = labelNamesOf(body);
    if (labels !== null) {
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${name}" does not exist` }] });
          return;
        }
      }
      issue.labels = labels;
    }
    issue.updatedSec = tick();
    sendJson(ctx.res, 200, issueJson(repo, issue));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

function handleIssueComments(ctx: RestContext, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  if (ctx.method === 'GET') {
    const page = pageOf(ctx.params);
    sendJson(ctx.res, 200, paginate(issue.comments, page).map((comment) => commentJson(comment)));
    return;
  }
  if (ctx.method === 'POST') {
    const body = parseBodyOr400(ctx.res, ctx.raw);
    if (body === null) return;
    const text = stringFieldOf(body, 'body');
    if (text === undefined) {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', code: 'custom', field: 'body', message: 'body is required' }] });
      return;
    }
    const comment = addComment(repo, issue, text);
    sendJson(ctx.res, 201, commentJson(comment));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

function handlePulls(ctx: RestContext, repo: Repo): void {
  if (ctx.method === 'GET') {
    const page = pageOf(ctx.params);
    const state = ctx.params.get('state') ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => b.seq - a.seq);
    sendJson(ctx.res, 200, paginate(pulls, page).map((pull) => pullJson(repo, pull, ctx.host)));
    return;
  }
  if (ctx.method === 'POST') {
    const body = parseBodyOr400(ctx.res, ctx.raw);
    if (body === null) return;
    const title = stringFieldOf(body, 'title');
    const headRaw = stringFieldOf(body, 'head');
    const baseRaw = stringFieldOf(body, 'base');
    if (title === undefined || headRaw === undefined || baseRaw === undefined) {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'title, head and base are required' }] });
      return;
    }
    const stripPrefix = (value: string): string => (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
    const head = stripPrefix(headRaw);
    const base = stripPrefix(baseRaw);
    const fail = (message: string): void => {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message }] });
    };
    if (branchTip(repo, head) === undefined) {
      fail(`head branch "${head}" does not exist`);
      return;
    }
    if (branchTip(repo, base) === undefined) {
      fail(`base branch "${base}" does not exist`);
      return;
    }
    if (head === base) {
      fail('head and base must differ');
      return;
    }
    const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate) {
      fail('a pull request already exists for this head and base');
      return;
    }
    const pull = createPull(repo, title, stringFieldOf(body, 'body') ?? '', head, base);
    sendJson(ctx.res, 201, pullJson(repo, pull, ctx.host));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

function handlePull(ctx: RestContext, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  if (ctx.method === 'GET') {
    sendJson(ctx.res, 200, pullJson(repo, pull, ctx.host));
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

function handlePullFiles(ctx: RestContext, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  const analysis = analysePull(repo, pull);
  if (analysis === null) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const files = analysis.diffs.map((diff) => {
    const beforeText = diff.before === null ? '' : blobText(diff.before.oid);
    const afterText = diff.after === null ? '' : blobText(diff.after.oid);
    const counts = lineDiffCounts(beforeText, afterText);
    return {
      sha: (diff.after ?? diff.before)?.oid ?? '',
      filename: diff.path,
      status: diff.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
  sendJson(ctx.res, 200, files);
}

function handlePullMerge(ctx: RestContext, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    repoNotFound(ctx.res);
    return;
  }
  parseBodyOr400(ctx.res, ctx.raw);
  if (pull.state !== 'open') {
    sendJson(ctx.res, 405, { message: pull.merged ? 'Pull Request already merged' : 'Pull Request is not mergeable' });
    return;
  }
  const analysis = analysePull(repo, pull);
  if (analysis === null || analysis.conflict) {
    sendJson(ctx.res, 405, { message: 'Pull Request is not mergeable' });
    return;
  }
  const sha = squashMerge(repo, pull, analysis);
  sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

/** Dispatch inside /api/v3; `segments` is the path after the prefix, already decoded. */
function handleRest(ctx: RestContext, segments: string[]): void {
  const [first, second, third] = segments;
  if (segments.length === 0 || (segments.length === 1 && first === '')) {
    if (ctx.method === 'GET') handleRestRoot(ctx);
    else sendError(ctx.res, 404, 'Not Found');
    return;
  }
  if (first === 'meta' && segments.length === 1) {
    if (ctx.method === 'GET') handleRestMeta(ctx);
    else sendError(ctx.res, 404, 'Not Found');
    return;
  }
  if (first === 'user' && segments.length === 1) {
    if (ctx.method === 'GET') sendJson(ctx.res, 200, userJson());
    else sendError(ctx.res, 404, 'Not Found');
    return;
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (ctx.method === 'POST') handleCreateRepo(ctx);
    else if (ctx.method === 'GET') handleListUserRepos(ctx);
    else sendError(ctx.res, 404, 'Not Found');
    return;
  }
  if (first === 'repos' && segments.length >= 3) {
    const repo = addressedRepo(ctx.res, second as string, third as string);
    if (repo === null) return;
    const rest = segments.slice(3);
    if (rest.length === 0) {
      handleRepo(ctx, repo);
      return;
    }
    const [area, arg] = rest;
    if (area === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (ctx.method === 'POST') handleCreateRef(ctx, repo);
      else sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (area === 'git' && rest[1] === 'refs' && rest.length >= 3) {
      if (ctx.method === 'GET') handleGetRef(ctx, repo, rest.slice(2).join('/'));
      else sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (area === 'branches' && rest.length === 1) {
      if (ctx.method === 'GET') handleBranches(ctx, repo, null);
      else sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (area === 'branches' && rest.length >= 2) {
      if (ctx.method === 'GET') handleBranches(ctx, repo, rest.slice(1).join('/'));
      else sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (area === 'commits' && rest.length === 1) {
      if (ctx.method === 'GET') handleCommits(ctx, repo);
      else sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (area === 'contents') {
      const path = rest.slice(1).join('/');
      if (ctx.method === 'GET') handleGetContents(ctx, repo, path);
      else if (ctx.method === 'PUT') handlePutContents(ctx, repo, path);
      else if (ctx.method === 'DELETE') handleDeleteContents(ctx, repo, path);
      else sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (area === 'labels' && rest.length === 1) {
      handleLabels(ctx, repo);
      return;
    }
    if (area === 'issues' && rest.length === 1) {
      handleIssues(ctx, repo);
      return;
    }
    if (area === 'issues' && rest.length === 2) {
      const number = Number(arg);
      if (Number.isInteger(number)) handleIssue(ctx, repo, number);
      else repoNotFound(ctx.res);
      return;
    }
    if (area === 'issues' && rest.length === 3 && rest[2] === 'comments') {
      const number = Number(arg);
      if (Number.isInteger(number)) handleIssueComments(ctx, repo, number);
      else repoNotFound(ctx.res);
      return;
    }
    if (area === 'pulls' && rest.length === 1) {
      handlePulls(ctx, repo);
      return;
    }
    if (area === 'pulls' && rest.length === 2) {
      const number = Number(arg);
      if (Number.isInteger(number)) handlePull(ctx, repo, number);
      else repoNotFound(ctx.res);
      return;
    }
    if (area === 'pulls' && rest.length === 3 && rest[2] === 'files') {
      const number = Number(arg);
      if (Number.isInteger(number) && ctx.method === 'GET') handlePullFiles(ctx, repo, number);
      else repoNotFound(ctx.res);
      return;
    }
    if (area === 'pulls' && rest.length === 3 && rest[2] === 'merge') {
      const number = Number(arg);
      if (Number.isInteger(number) && ctx.method === 'PUT') handlePullMerge(ctx, repo, number);
      else repoNotFound(ctx.res);
      return;
    }
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  sendError(ctx.res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Git smart HTTP, at /{owner}/{repo}.git. Protocol v2 for upload-pack when the client asks for
// it, v0 otherwise and always for receive-pack. Packs carry plain objects only.

const AGENT_STRING = 'makefun-forge/1.0';

function gitRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return null;
  }
  const repo = repos.get(name);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return null;
  }
  return repo;
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

/** Sorted ref advertisement lines: HEAD first (when it resolves or is unborn), then the refs. */
function refLines(repo: Repo, options: { peel: boolean; unborn: boolean }): string[] {
  const lines: string[] = [];
  const headTarget = headRefOf(repo);
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) {
    lines.push(`${headOid} HEAD symref-target:${headTarget}`);
  } else if (options.unborn) {
    lines.push(`unborn HEAD symref-target:${headTarget}`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (options.peel) {
      const object = getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return lines;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT_STRING}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return;
  }
  const caps = service === 'git-upload-pack'
    ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag agent=${AGENT_STRING} symref=HEAD:${headRefOf(repo)}`
    : `report-status delete-refs side-band-64k quiet ofs-delta agent=${AGENT_STRING} symref=HEAD:${headRefOf(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headOid = repo.refs.get(headRefOf(repo));
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      if (first) {
        parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${name}\n`));
      }
      const object = getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

function handleLsRefs(res: ServerResponse, repo: Repo, argLines: string[]): void {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = headRefOf(repo);
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${headTarget}`;
      parts.push(pktLine(`${line}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/** Which objects a fetch sends: the wants' closure minus what the haves already cover. */
function planFetch(wants: string[], haves: string[], clientShallow: Set<string>, depth: number | null): FetchPlan {
  const haveExclude = new Set<string>();
  for (const have of haves) {
    if (getObject(have) === undefined) continue;
    if (clientShallow.has(have)) {
      haveExclude.add(have);
      const commit = getObject(have);
      if (commit !== undefined && commit.type === 'commit') {
        haveExclude.add(parseCommit(commit.data).tree);
        // the tree's own closure: walk the tree only, not the parents
        const stack = [parseCommit(commit.data).tree];
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (haveExclude.has(oid)) continue;
          const object = getObject(oid);
          if (object === undefined) continue;
          haveExclude.add(oid);
          if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
        }
      }
    } else {
      for (const oid of closureOf([have])) haveExclude.add(oid);
    }
  }
  const include = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const addClosure = (root: string): void => {
    for (const oid of closureOf([root])) {
      if (!haveExclude.has(oid)) include.add(oid);
    }
  };
  const validWants = wants.filter((want) => getObject(want) !== undefined);
  if (depth === null) {
    // Commits stop at the client's shallow boundary; everything else closes fully.
    const commitSeen = new Set<string>();
    const stack = [...validWants];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const object = getObject(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        if (commitSeen.has(oid)) continue;
        commitSeen.add(oid);
        if (!haveExclude.has(oid)) {
          include.add(oid);
          include.add(parseCommit(object.data).tree);
          addClosure(parseCommit(object.data).tree);
        }
        if (!clientShallow.has(oid)) {
          for (const parent of parseCommit(object.data).parents) stack.push(parent);
        }
      } else {
        addClosure(oid);
      }
    }
  } else {
    // Depth-limited: commits within `depth` generations of a want, plus their trees.
    const generation = new Map<string, number>();
    let frontier = validWants.filter((want) => (getObject(want) as GitObject).type === 'commit');
    for (const want of validWants) {
      if ((getObject(want) as GitObject).type !== 'commit') addClosure(want);
    }
    for (let gen = 1; gen <= depth; gen += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (generation.has(oid)) continue;
        generation.set(oid, gen);
        const commit = getObject(oid) as GitObject;
        const info = parseCommit(commit.data);
        for (const parent of info.parents) next.push(parent);
      }
      frontier = next;
    }
    for (const oid of generation.keys()) {
      if (haveExclude.has(oid)) continue;
      include.add(oid);
      const info = parseCommit((getObject(oid) as GitObject).data);
      addClosure(info.tree);
      const hasParentOutside = info.parents.some((parent) => !generation.has(parent) && !haveExclude.has(parent));
      const hasParentAtAll = info.parents.length > 0;
      if (hasParentAtAll && (hasParentOutside || info.parents.some((parent) => !generation.has(parent)))) {
        if (info.parents.some((parent) => getObject(parent) !== undefined && !generation.has(parent))) shallow.add(oid);
      }
    }
    for (const oid of clientShallow) {
      const object = getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const info = parseCommit(object.data);
      if (info.parents.length > 0 && info.parents.every((parent) => generation.has(parent) || haveExclude.has(parent))) {
        unshallow.add(oid);
      }
    }
  }
  // Order: commits first (any order is valid in a pack), then the rest.
  const commits: string[] = [];
  const others: string[] = [];
  for (const oid of include) {
    const object = getObject(oid) as GitObject;
    if (object.type === 'commit') commits.push(oid);
    else others.push(oid);
  }
  return { oids: [...commits, ...others], shallow: [...shallow], unshallow: [...unshallow] };
}

/** Frame pack bytes as side-band-64k data packets (band 1), each within the pkt-line limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, offset + chunkSize);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function handleFetchV2(res: ServerResponse, repo: Repo, argLines: string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let done = false;
  for (const line of argLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line === 'done') done = true;
  }
  void repo;
  const knownHaves = haves.filter((have) => getObject(have) !== undefined);
  const plan = planFetch(wants, haves, clientShallow, depth);
  const sections: Buffer[] = [];
  if (haves.length > 0 || done) {
    const ack: Buffer[] = [pktLine('acknowledgments\n')];
    if (knownHaves.length === 0) {
      ack.push(pktLine('NAK\n'));
    } else {
      for (const have of knownHaves) ack.push(pktLine(`ACK ${have} common\n`));
      if (done) ack.push(pktLine('ready\n'));
    }
    sections.push(...ack, PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const info: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of plan.shallow) info.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) info.push(pktLine(`unshallow ${oid}\n`));
    sections.push(...info, PKT_DELIM);
  }
  const pack = buildPack(plan.oids);
  sections.push(pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(sections));
}

function handleFetchV0(res: ServerResponse, body: Buffer): void {
  const parsed = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let seenWants = false;
  for (const packet of parsed.packets) {
    if (packet.kind === 'flush') {
      seenWants = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenWants) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(wants, haves, new Set(), depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(buildPack(plan.oids)));
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const parsed = parsePktLines(body);
  if (!parsed.ok || parsed.packets.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('malformed request\n');
    return;
  }
  const first = parsed.packets[0];
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2')
    || (first !== undefined && first.kind === 'data' && first.payload.toString('utf8').startsWith('command='));
  if (!isV2) {
    handleFetchV0(res, body);
    return;
  }
  let command = '';
  const argLines: string[] = [];
  let inArgs = false;
  for (const packet of parsed.packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      argLines.push(line);
    }
  }
  if (command === 'ls-refs') {
    handleLsRefs(res, repo, argLines);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(res, repo, argLines);
    return;
  }
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('unknown command\n');
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const parsed = parsePktLines(body);
  if (!parsed.ok) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('malformed request\n');
    return;
  }
  const commands: RefCommand[] = [];
  let reportStatus = false;
  let sideBand = false;
  for (const packet of parsed.packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      const caps = line.slice(nul + 1);
      if (caps.includes('report-status')) reportStatus = true;
      if (caps.includes('side-band-64k')) sideBand = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const packBytes = parsed.rest;
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes);
      for (const object of pack.objects) storeObject(object.type, object.data);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // A delete: always allowed except for the branch HEAD names.
      if (command.ref === headRefOf(repo)) {
        results.push({ ref: command.ref, ok: false, reason: 'deletion of the current branch prohibited' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (getObject(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'new object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined && current !== command.newOid) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      const newObject = getObject(command.newOid) as GitObject;
      const oldObject = getObject(command.oldOid);
      if (command.ref.startsWith('refs/heads/') && newObject.type === 'commit' && oldObject !== undefined && oldObject.type === 'commit') {
        if (!isAncestor(command.oldOid, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      if (command.ref.startsWith('refs/tags/') && current !== undefined && current !== command.newOid) {
        results.push({ ref: command.ref, ok: false, reason: 'would clobber existing tag' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  if (results.some((result) => result.ok)) repo.updatedSec = tick();
  if (!reportStatus) {
    sendBytes(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const inner: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  if (!sideBand) {
    sendBytes(res, 200, 'application/x-git-receive-pack-result', innerBytes);
    return;
  }
  const outer: Buffer[] = [];
  const chunkSize = 65_519;
  for (let offset = 0; offset < innerBytes.length; offset += chunkSize) {
    const chunk = innerBytes.subarray(offset, offset + chunkSize);
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outer.push(PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(outer));
}

function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, name: string, tail: string, body: Buffer): void {
  const repo = gitRepoOr404(res, owner, name);
  if (repo === null) return;
  if (tail === 'info/refs') {
    const service = new URL(req.url ?? '/', 'http://forge').searchParams.get('service') ?? '';
    handleInfoRefs(req, res, repo, service);
    return;
  }
  if (tail === 'git-upload-pack') {
    handleUploadPack(req, res, repo, body);
    return;
  }
  if (tail === 'git-receive-pack') {
    handleReceivePack(res, repo, body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4 (POST /api/graphql): a small lexer/parser/executor over a fixed schema, reading and
// writing the same store as REST. Global ids are opaque base64 ("Kind:parts"), stable per object.

class GqlError extends Error {}

interface GqlValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  items?: GqlValueNode[];
  fields?: Array<{ name: string; value: GqlValueNode }>;
}

interface GqlFieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: GqlValueNode }> }>;
  selectionSet: GqlSelection[] | null;
}

type GqlSelection =
  | GqlFieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, GqlValueNode>;
  selectionSet: GqlSelection[];
}

function lexGraphql(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: c, value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let kind = 'int';
      if (source[j] === '.') {
        kind = 'float';
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  #tokens: Array<{ kind: string; value: string }>;
  #pos = 0;

  constructor(source: string) {
    this.#tokens = lexGraphql(source);
  }

  #peek(): { kind: string; value: string } {
    return this.#tokens[this.#pos] as { kind: string; value: string };
  }

  #next(): { kind: string; value: string } {
    const token = this.#tokens[this.#pos] as { kind: string; value: string };
    this.#pos += 1;
    return token;
  }

  #expect(kind: string): { kind: string; value: string } {
    const token = this.#next();
    if (token.kind !== kind) throw new GqlError(`expected ${kind}, found ${token.kind} ${token.value}`);
    return token;
  }

  #skip(kind: string): boolean {
    if (this.#peek().kind === kind) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, { typeCondition: string; selectionSet: GqlSelection[] }> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>();
    while (this.#peek().kind !== 'eof') {
      const token = this.#peek();
      if (token.kind === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.#parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.#next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#next().value;
        const variableDefaults = new Map<string, GqlValueNode>();
        if (this.#skip('(')) {
          while (this.#peek().kind !== ')') {
            this.#expect('$');
            const varName = this.#expect('name').value;
            this.#expect(':');
            this.#parseTypeRef();
            if (this.#skip('=')) variableDefaults.set(varName, this.#parseValue(false));
            this.#parseDirectives();
          }
          this.#expect(')');
        }
        this.#parseDirectives();
        operations.push({ type, name, variableDefaults, selectionSet: this.#parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.#next();
        const fragName = this.#expect('name').value;
        const on = this.#expect('name');
        if (on.value !== 'on') throw new GqlError('expected "on" in fragment definition');
        const typeCondition = this.#expect('name').value;
        this.#parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.#parseSelectionSet() });
        continue;
      }
      throw new GqlError(`unexpected token ${token.kind} ${token.value}`);
    }
    return { operations, fragments };
  }

  #parseTypeRef(): void {
    if (this.#skip('[')) {
      this.#parseTypeRef();
      this.#expect(']');
    } else {
      this.#expect('name');
    }
    this.#skip('!');
  }

  #parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: GqlValueNode }> }> {
    const directives: Array<{ name: string; args: Array<{ name: string; value: GqlValueNode }> }> = [];
    while (this.#skip('@')) {
      const name = this.#expect('name').value;
      const args: Array<{ name: string; value: GqlValueNode }> = [];
      if (this.#skip('(')) {
        while (this.#peek().kind !== ')') {
          const argName = this.#expect('name').value;
          this.#expect(':');
          args.push({ name: argName, value: this.#parseValue(true) });
        }
        this.#expect(')');
      }
      directives.push({ name, args });
    }
    return directives;
  }

  #parseSelectionSet(): GqlSelection[] {
    this.#expect('{');
    const selections: GqlSelection[] = [];
    while (this.#peek().kind !== '}') selections.push(this.#parseSelection());
    this.#expect('}');
    return selections;
  }

  #parseSelection(): GqlSelection {
    if (this.#skip('...')) {
      if (this.#peek().kind === 'name' && this.#peek().value === 'on') {
        this.#next();
        const typeCondition = this.#expect('name').value;
        this.#parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.#parseSelectionSet() };
      }
      if (this.#peek().kind === '{') {
        return { kind: 'inline', typeCondition: null, selectionSet: this.#parseSelectionSet() };
      }
      const name = this.#expect('name').value;
      this.#parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.#expect('name').value;
    let alias: string | null = null;
    if (this.#skip(':')) {
      alias = name;
      name = this.#expect('name').value;
    }
    const args: Array<{ name: string; value: GqlValueNode }> = [];
    if (this.#skip('(')) {
      while (this.#peek().kind !== ')') {
        const argName = this.#expect('name').value;
        this.#expect(':');
        args.push({ name: argName, value: this.#parseValue(true) });
      }
      this.#expect(')');
    }
    const directives = this.#parseDirectives();
    const selectionSet = this.#peek().kind === '{' ? this.#parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  #parseValue(allowVariable: boolean): GqlValueNode {
    const token = this.#next();
    if (token.kind === '$') {
      if (!allowVariable) throw new GqlError('variable not allowed here');
      return { kind: 'variable', value: this.#expect('name').value };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === '[') {
      const items: GqlValueNode[] = [];
      while (this.#peek().kind !== ']') items.push(this.#parseValue(allowVariable));
      this.#expect(']');
      return { kind: 'list', items };
    }
    if (token.kind === '{') {
      const fields: Array<{ name: string; value: GqlValueNode }> = [];
      while (this.#peek().kind !== '}') {
        const fieldName = this.#expect('name').value;
        this.#expect(':');
        fields.push({ name: fieldName, value: this.#parseValue(allowVariable) });
      }
      this.#expect('}');
      return { kind: 'object', fields };
    }
    throw new GqlError(`unexpected value token ${token.kind}`);
  }
}

function valueOf(node: GqlValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.value as string];
    case 'list': return (node.items ?? []).map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default: return node.value;
  }
}

// The fixed schema, as data: field names, type references and enum members drive both execution
// and introspection.
interface GqlTypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Array<{ name: string; type: string; args?: Record<string, string> }>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
}

const GQL_TYPES: Record<string, GqlTypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User!' },
      { name: 'repository', type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      { name: 'node', type: 'Node', args: { id: 'ID!' } },
      { name: 'rateLimit', type: 'String' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      { name: 'closeIssue', type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      { name: 'addComment', type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'login', type: 'String!' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int!' },
      { name: 'name', type: 'String!' },
      { name: 'nameWithOwner', type: 'String!' },
      { name: 'owner', type: 'User!' },
      { name: 'isPrivate', type: 'Boolean!' },
      { name: 'description', type: 'String' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission!' },
      { name: 'hasIssuesEnabled', type: 'Boolean!' },
      { name: 'issue', type: 'Issue', args: { number: 'Int!' } },
      { name: 'issues', type: 'IssueConnection!', args: { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' } },
      { name: 'pullRequest', type: 'PullRequest', args: { number: 'Int!' } },
      { name: 'pullRequests', type: 'PullRequestConnection!', args: { first: 'Int', after: 'String', states: '[PullRequestState!]' } },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'prefix', type: 'String!' },
    ],
  },
  Commit: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'oid', type: 'String!' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String!' },
      { name: 'state', type: 'IssueState!' },
      { name: 'url', type: 'String!' },
      { name: 'author', type: 'User' },
      { name: 'repository', type: 'Repository!' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[Issue]' },
      { name: 'edges', type: '[IssueEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Issue' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String!' },
      { name: 'state', type: 'PullRequestState!' },
      { name: 'merged', type: 'Boolean!' },
      { name: 'mergeable', type: 'MergeableState!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefOid', type: 'String' },
      { name: 'baseRefOid', type: 'String' },
      { name: 'mergedAt', type: 'String' },
      { name: 'mergeCommit', type: 'Commit' },
      { name: 'author', type: 'User' },
      { name: 'repository', type: 'Repository!' },
      { name: 'files', type: 'PullRequestChangedFileConnection', args: { first: 'Int', after: 'String' } },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequest]' },
      { name: 'edges', type: '[PullRequestEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequest' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String!' },
      { name: 'additions', type: 'Int!' },
      { name: 'deletions', type: 'Int!' },
      { name: 'changeType', type: 'String!' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequestChangedFile]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'body', type: 'String!' },
      { name: 'author', type: 'User' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean!' },
      { name: 'hasPreviousPage', type: 'Boolean!' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }] },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'commentEdge', type: 'IssueCommentEdge' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'IssueComment' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  Node: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!' } },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', headRefName: 'String!', baseRefName: 'String!' } },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID!', body: 'String!' } },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'kind', type: 'String!' },
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'fields', type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
      { name: 'inputFields', type: '[__InputValue]' },
      { name: 'enumValues', type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
      { name: 'possibleTypes', type: '[__Type]' },
      { name: 'ofType', type: '__Type' },
    ],
  },
  __Field: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'args', type: '[__InputValue!]!' },
      { name: 'type', type: '__Type!' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'type', type: '__Type!' },
      { name: 'defaultValue', type: 'String' },
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      { name: 'types', type: '[__Type!]!' },
      { name: 'queryType', type: '__Type!' },
      { name: 'mutationType', type: '__Type' },
      { name: 'subscriptionType', type: '__Type' },
      { name: 'directives', type: '[__Directive!]!' },
    ],
  },
  __Directive: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'locations', type: '[String!]!' },
      { name: 'args', type: '[__InputValue!]!' },
    ],
  },
};

// Executor sources: domain objects wrapped with their GraphQL type and their opaque node id.
interface GqlSource {
  gqlType: string;
  nodeId?: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  comment?: IssueComment;
  refName?: string;
  oid?: string;
  items?: GqlSource[];
  cursors?: string[];
  totalCount?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  startCursor?: string | null;
  filePath?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
  payloadKey?: string;
  typeName?: string;
  typeRef?: string;
  fieldDef?: { name: string; type: string; args?: Record<string, string> };
  enumName?: string;
  inputValue?: { name: string; type: string };
}

const userSource = (): GqlSource => ({ gqlType: 'User', nodeId: globalId('User', VIEWER.login) });
const repoSource = (repo: Repo): GqlSource => ({ gqlType: 'Repository', repo, nodeId: globalId('Repository', repo.id) });
const issueSource = (repo: Repo, issue: Issue): GqlSource => ({ gqlType: 'Issue', repo, issue, nodeId: globalId('Issue', repo.id, issue.number) });
const pullSource = (repo: Repo, pull: Pull): GqlSource => ({ gqlType: 'PullRequest', repo, pull, nodeId: globalId('PullRequest', repo.id, pull.number) });
const commentSource = (repo: Repo, issue: Issue, comment: IssueComment): GqlSource => ({ gqlType: 'IssueComment', repo, issue, comment, nodeId: globalId('IssueComment', comment.id) });

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Slice a seq-ordered list into a connection page. */
function connectionPage(items: GqlSource[], seqs: number[], args: Record<string, unknown>, type: string): GqlSource {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const afterSeq = seqOfCursor(args.after);
    if (afterSeq !== null) {
      const index = seqs.indexOf(afterSeq);
      if (index !== -1) start = index + 1;
    }
  }
  const pageItems = items.slice(start, start + first);
  const pageSeqs = seqs.slice(start, start + first);
  return {
    gqlType: type,
    items: pageItems,
    cursors: pageSeqs.map((seq) => cursorOf(seq)),
    totalCount: items.length,
    hasNextPage: start + first < items.length,
    endCursor: pageSeqs.length > 0 ? cursorOf(pageSeqs[pageSeqs.length - 1] as number) : null,
    startCursor: pageSeqs.length > 0 ? cursorOf(pageSeqs[0] as number) : null,
  };
}

function findRepoByDbId(dbId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function nodeSource(id: string): GqlSource | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoByDbId(Number(parsed.parts[0]));
    return repo === undefined ? null : repoSource(repo);
  }
  if (parsed.kind === 'Issue') {
    const repo = findRepoByDbId(Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    return repo !== undefined && issue !== undefined ? issueSource(repo, issue) : null;
  }
  if (parsed.kind === 'PullRequest') {
    const repo = findRepoByDbId(Number(parsed.parts[0]));
    const pull = repo?.pulls.get(Number(parsed.parts[1]));
    return repo !== undefined && pull !== undefined ? pullSource(repo, pull) : null;
  }
  if (parsed.kind === 'IssueComment') {
    const found = commentIndex.get(Number(parsed.parts[0]));
    if (found === undefined) return null;
    const comment = found.issue.comments.find((candidate) => candidate.id === Number(parsed.parts[0]));
    return comment === undefined ? null : commentSource(found.repo, found.issue, comment);
  }
  if (parsed.kind === 'User') return parsed.parts[0] === VIEWER.login ? userSource() : null;
  return null;
}

type GqlResolver = (source: GqlSource, args: Record<string, unknown>) => unknown;

const GQL_RESOLVERS: Record<string, Record<string, GqlResolver>> = {
  Query: {
    viewer: () => userSource(),
    repository: (_source, args) => {
      if (args.owner !== VIEWER.login || typeof args.name !== 'string') return null;
      const repo = repos.get(args.name);
      return repo === undefined ? null : repoSource(repo);
    },
    node: (_source, args) => (typeof args.id === 'string' ? nodeSource(args.id) : null),
    rateLimit: () => null,
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = asObject(args.input) ?? {};
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) throw new GqlError('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('title is required');
      const issue = createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
      return { gqlType: 'CreateIssuePayload', payloadKey: 'issue', items: [issueSource(repo, issue)] } as GqlSource;
    },
    closeIssue: (_source, args) => {
      const input = asObject(args.input) ?? {};
      const target = typeof input.issueId === 'string' ? nodeSource(input.issueId) : null;
      if (target === null || target.gqlType !== 'Issue' || target.issue === undefined || target.repo === undefined) throw new GqlError('issue not found');
      target.issue.state = 'closed';
      target.issue.updatedSec = tick();
      return { gqlType: 'CloseIssuePayload', payloadKey: 'issue', items: [target] } as GqlSource;
    },
    createPullRequest: (_source, args) => {
      const input = asObject(args.input) ?? {};
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) throw new GqlError('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const title = String(input.title ?? '');
      if (branchTip(repo, head) === undefined) throw new GqlError(`head branch "${head}" does not exist`);
      if (branchTip(repo, base) === undefined) throw new GqlError(`base branch "${base}" does not exist`);
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) throw new GqlError('a pull request already exists for this head and base');
      const pull = createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
      return { gqlType: 'CreatePullRequestPayload', payloadKey: 'pullRequest', items: [pullSource(repo, pull)] } as GqlSource;
    },
    mergePullRequest: (_source, args) => {
      const input = asObject(args.input) ?? {};
      const target = typeof input.pullRequestId === 'string' ? nodeSource(input.pullRequestId) : null;
      if (target === null || target.gqlType !== 'PullRequest' || target.pull === undefined || target.repo === undefined) throw new GqlError('pull request not found');
      const pull = target.pull;
      if (pull.state !== 'open') throw new GqlError('Pull Request already merged');
      const analysis = analysePull(target.repo, pull);
      if (analysis === null || analysis.conflict) throw new GqlError('Pull Request is not mergeable');
      squashMerge(target.repo, pull, analysis);
      return { gqlType: 'MergePullRequestPayload', payloadKey: 'pullRequest', items: [target] } as GqlSource;
    },
    addComment: (_source, args) => {
      const input = asObject(args.input) ?? {};
      const target = typeof input.subjectId === 'string' ? nodeSource(input.subjectId) : null;
      if (target === null || target.gqlType !== 'Issue' || target.issue === undefined || target.repo === undefined) throw new GqlError('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addComment(target.repo, target.issue, body);
      const node = commentSource(target.repo, target.issue, comment);
      return { gqlType: 'AddCommentPayload', payloadKey: 'commentEdge', items: [{ gqlType: 'IssueCommentEdge', items: [node], cursors: [cursorOf(comment.id)] } as GqlSource] } as GqlSource;
    },
  },
  User: {
    id: (source) => source.nodeId,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (source) => source.nodeId,
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${VIEWER.login}/${(source.repo as Repo).name}`,
    owner: () => userSource(),
    isPrivate: (source) => (source.repo as Repo).priv,
    description: (source) => (source.repo as Repo).description,
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      return repo.refs.has(headRefOf(repo)) ? ({ gqlType: 'Ref', refName: repo.defaultBranch } as GqlSource) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (source, args) => {
      const repo = source.repo as Repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null && states.length > 0) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = asObject(args.orderBy);
      const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : null;
      if (orderBy !== null) issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      else issues.sort((a, b) => a.seq - b.seq);
      return connectionPage(issues.map((issue) => issueSource(repo, issue)), issues.map((issue) => issue.seq), args, 'IssueConnection');
    },
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullSource(repo, pull);
    },
    pullRequests: (source, args) => {
      const repo = source.repo as Repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null && states.length > 0) {
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return states.includes(state);
        });
      }
      pulls.sort((a, b) => b.seq - a.seq);
      return connectionPage(pulls.map((pull) => pullSource(repo, pull)), pulls.map((pull) => pull.seq), args, 'PullRequestConnection');
    },
  },
  Ref: {
    name: (source) => source.refName,
    prefix: () => 'refs/heads/',
  },
  Commit: {
    id: (source) => globalId('Commit', source.oid ?? ''),
    oid: (source) => source.oid,
  },
  Issue: {
    id: (source) => source.nodeId,
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    body: (source) => (source.issue as Issue).body,
    state: (source) => (source.issue as Issue).state.toUpperCase(),
    url: (source) => `http://forge/${VIEWER.login}/${(source.repo as Repo).name}/issues/${(source.issue as Issue).number}`,
    author: () => userSource(),
    repository: (source) => repoSource(source.repo as Repo),
  },
  PullRequest: {
    id: (source) => source.nodeId,
    number: (source) => (source.pull as Pull).number,
    title: (source) => (source.pull as Pull).title,
    body: (source) => (source.pull as Pull).body,
    state: (source) => {
      const pull = source.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as Pull).merged,
    mergeable: (source) => {
      const pull = source.pull as Pull;
      if (pull.merged) return 'MERGEABLE';
      if (pull.state !== 'open') return 'UNKNOWN';
      const analysis = analysePull(source.repo as Repo, pull);
      if (analysis === null) return 'UNKNOWN';
      return analysis.conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (source) => (source.pull as Pull).headRef,
    baseRefName: (source) => (source.pull as Pull).baseRef,
    headRefOid: (source) => {
      const pull = source.pull as Pull;
      return branchTip(source.repo as Repo, pull.headRef) ?? pull.headShaSnapshot;
    },
    baseRefOid: (source) => branchTip(source.repo as Repo, (source.pull as Pull).baseRef) ?? null,
    mergedAt: (source) => {
      const pull = source.pull as Pull;
      return pull.mergedSec === null ? null : isoOf(pull.mergedSec);
    },
    mergeCommit: (source) => {
      const pull = source.pull as Pull;
      return pull.mergeCommitSha === null ? null : ({ gqlType: 'Commit', oid: pull.mergeCommitSha } as GqlSource);
    },
    author: () => userSource(),
    repository: (source) => repoSource(source.repo as Repo),
    files: (source, args) => {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      const analysis = analysePull(repo, pull);
      const diffs = analysis === null ? [] : analysis.diffs;
      const items: GqlSource[] = diffs.map((diff) => {
        const counts = lineDiffCounts(diff.before === null ? '' : blobText(diff.before.oid), diff.after === null ? '' : blobText(diff.after.oid));
        return {
          gqlType: 'PullRequestChangedFile',
          filePath: diff.path,
          additions: counts.additions,
          deletions: counts.deletions,
          changeType: diff.status === 'added' ? 'ADDED' : diff.status === 'removed' ? 'DELETED' : 'MODIFIED',
        } as GqlSource;
      });
      const seqs = items.map((_item, index) => index + 1);
      return connectionPage(items, seqs, args, 'PullRequestChangedFileConnection');
    },
  },
  PullRequestChangedFile: {
    path: (source) => source.filePath,
    additions: (source) => source.additions,
    deletions: (source) => source.deletions,
    changeType: (source) => source.changeType,
  },
  IssueComment: {
    id: (source) => source.nodeId,
    body: (source) => (source.comment as IssueComment).body,
    author: () => userSource(),
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage ?? false,
    hasPreviousPage: () => false,
    startCursor: (source) => source.startCursor ?? null,
    endCursor: (source) => source.endCursor ?? null,
  },
  IssueConnection: connectionResolvers('Issue'),
  PullRequestConnection: connectionResolvers('PullRequest'),
  PullRequestChangedFileConnection: connectionResolvers('PullRequestChangedFile'),
  IssueEdge: edgeResolvers(),
  PullRequestEdge: edgeResolvers(),
  IssueCommentEdge: edgeResolvers(),
  CreateIssuePayload: payloadResolvers(),
  CloseIssuePayload: payloadResolvers(),
  CreatePullRequestPayload: payloadResolvers(),
  MergePullRequestPayload: payloadResolvers(),
  AddCommentPayload: payloadResolvers(),
  __Type: {
    kind: (source) => typeKindOf(source),
    name: (source) => typeNameOf(source),
    description: () => null,
    fields: (source) => {
      const name = typeNameOf(source);
      const def = name === null ? undefined : GQL_TYPES[name];
      if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
      return (def.fields ?? []).map((fieldDef) => ({ gqlType: '__Field', fieldDef } as GqlSource));
    },
    enumValues: (source) => {
      const name = typeNameOf(source);
      const def = name === null ? undefined : GQL_TYPES[name];
      if (def === undefined || def.kind !== 'ENUM') return null;
      return (def.enumValues ?? []).map((enumName) => ({ gqlType: '__EnumValue', enumName } as GqlSource));
    },
    inputFields: (source) => {
      const name = typeNameOf(source);
      const def = name === null ? undefined : GQL_TYPES[name];
      if (def === undefined || def.kind !== 'INPUT_OBJECT') return null;
      return Object.entries(def.inputFields ?? {}).map(([inputName, inputType]) => ({ gqlType: '__InputValue', inputValue: { name: inputName, type: inputType } } as GqlSource));
    },
    possibleTypes: (source) => {
      const name = typeNameOf(source);
      if (name !== 'Node') return null;
      return ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'].map((typeName) => ({ gqlType: '__Type', typeName } as GqlSource));
    },
    ofType: (source) => {
      const ref = source.typeRef;
      if (ref === undefined) return null;
      if (ref.endsWith('!')) return { gqlType: '__Type', typeRef: ref.slice(0, -1) } as GqlSource;
      if (ref.startsWith('[') && ref.endsWith(']')) return { gqlType: '__Type', typeRef: ref.slice(1, -1) } as GqlSource;
      return null;
    },
  },
  __Field: {
    name: (source) => (source.fieldDef as { name: string }).name,
    description: () => null,
    args: (source) => Object.entries((source.fieldDef as { args?: Record<string, string> }).args ?? {}).map(([inputName, inputType]) => ({ gqlType: '__InputValue', inputValue: { name: inputName, type: inputType } } as GqlSource)),
    type: (source) => ({ gqlType: '__Type', typeRef: (source.fieldDef as { type: string }).type } as GqlSource),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (source) => (source.inputValue as { name: string }).name,
    description: () => null,
    type: (source) => ({ gqlType: '__Type', typeRef: (source.inputValue as { type: string }).type } as GqlSource),
    defaultValue: () => null,
  },
  __EnumValue: {
    name: (source) => source.enumName,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => Object.keys(GQL_TYPES).map((typeName) => ({ gqlType: '__Type', typeName } as GqlSource)),
    queryType: () => ({ gqlType: '__Type', typeName: 'Query' } as GqlSource),
    mutationType: () => ({ gqlType: '__Type', typeName: 'Mutation' } as GqlSource),
    subscriptionType: () => null,
    directives: () => [],
  },
};

function connectionResolvers(_nodeType: string): Record<string, GqlResolver> {
  return {
    nodes: (source) => source.items ?? [],
    edges: (source) => (source.items ?? []).map((item, index) => ({ gqlType: `${source.gqlType.replace('Connection', '')}Edge`, items: [item], cursors: [source.cursors?.[index] ?? ''] } as GqlSource)),
    pageInfo: (source) => ({ gqlType: 'PageInfo', hasNextPage: source.hasNextPage ?? false, endCursor: source.endCursor ?? null, startCursor: source.startCursor ?? null } as GqlSource),
    totalCount: (source) => source.totalCount ?? (source.items ?? []).length,
  };
}

function edgeResolvers(): Record<string, GqlResolver> {
  return {
    node: (source) => (source.items ?? [])[0] ?? null,
    cursor: (source) => (source.cursors ?? [])[0] ?? '',
  };
}

function payloadResolvers(): Record<string, GqlResolver> {
  return {
    issue: (source) => (source.items ?? [])[0] ?? null,
    pullRequest: (source) => (source.items ?? [])[0] ?? null,
    commentEdge: (source) => (source.items ?? [])[0] ?? null,
    clientMutationId: () => null,
  };
}

/** The named type inside a type reference, and its kind. */
function typeNameOf(source: GqlSource): string | null {
  if (source.typeName !== undefined) return source.typeName;
  const ref = source.typeRef;
  if (ref === undefined) return null;
  if (ref.endsWith('!') || (ref.startsWith('[') && ref.endsWith(']'))) return null;
  return ref;
}

function typeKindOf(source: GqlSource): string {
  const ref = source.typeRef;
  if (ref !== undefined) {
    if (ref.endsWith('!')) return 'NON_NULL';
    if (ref.startsWith('[') && ref.endsWith(']')) return 'LIST';
    const def = GQL_TYPES[ref];
    return def === undefined ? 'SCALAR' : def.kind;
  }
  const name = source.typeName;
  const def = name === undefined ? undefined : GQL_TYPES[name];
  return def === undefined ? 'OBJECT' : def.kind;
}

const GQL_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

/** Parse a type reference into its base name and list-ness. */
function baseTypeOf(typeRef: string): string {
  return typeRef.replace(/[![\]]/g, '');
}

function isListType(typeRef: string): boolean {
  return typeRef.replace(/!$/, '').startsWith('[');
}

interface GqlExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>;
  errors: Array<{ message: string }>;
}

function directivesPass(field: GqlFieldNode, ctx: GqlExecContext): boolean {
  for (const directive of field.directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') continue;
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    if (ifArg === undefined) continue;
    const value = valueOf(ifArg.value, ctx.variables);
    if (directive.name === 'skip' && value === true) return false;
    if (directive.name === 'include' && value !== true) return false;
  }
  return true;
}

function executeSelectionSet(typeName: string, source: GqlSource, selections: GqlSelection[], ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      if (condition === null || condition === source.gqlType || condition === 'Node' || GQL_TYPES[condition] !== undefined && (condition === source.gqlType)) {
        Object.assign(out, executeSelectionSet(condition ?? typeName, source, selection.selectionSet, ctx));
      } else if (condition !== null && GQL_TYPES[condition] === undefined) {
        ctx.errors.push({ message: `Unknown type '${condition}'` });
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment '${selection.name}'` });
        continue;
      }
      if (fragment.typeCondition === source.gqlType || fragment.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(fragment.typeCondition, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    if (!directivesPass(selection, ctx)) continue;
    const key = selection.alias ?? selection.name;
    out[key] = executeField(typeName, source, selection, ctx);
  }
  return out;
}

function executeField(typeName: string, source: GqlSource, field: GqlFieldNode, ctx: GqlExecContext): unknown {
  if (field.name === '__typename') return source.gqlType;
  if (field.name === '__type' && (typeName === 'Query' || source.gqlType === 'Query')) {
    const args = argsOf(field, ctx);
    const name = typeof args.name === 'string' ? args.name : '';
    return GQL_TYPES[name] === undefined ? null : completeValue('__Type', { gqlType: '__Type', typeName: name } as GqlSource, field, ctx);
  }
  if (field.name === '__schema' && (typeName === 'Query' || source.gqlType === 'Query')) {
    return completeValue('__Schema', { gqlType: '__Schema' } as GqlSource, field, ctx);
  }
  const contextDef = GQL_TYPES[typeName];
  const concreteDef = GQL_TYPES[source.gqlType];
  const fieldDef = (contextDef?.fields ?? []).find((candidate) => candidate.name === field.name)
    ?? (concreteDef?.fields ?? []).find((candidate) => candidate.name === field.name)
    ?? (typeName === 'Node' || source.gqlType !== typeName ? (GQL_TYPES.Node?.fields ?? []).find((candidate) => candidate.name === field.name) : undefined);
  if (fieldDef === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName === 'Node' ? source.gqlType : typeName}'` });
    return null;
  }
  const resolver = (GQL_RESOLVERS[source.gqlType] ?? {})[field.name] ?? (GQL_RESOLVERS[typeName] ?? {})[field.name];
  let raw: unknown;
  try {
    if (resolver === undefined) {
      if (field.name === 'id' && source.nodeId !== undefined) raw = source.nodeId;
      else throw new GqlError(`Field '${field.name}' doesn't exist on type '${source.gqlType}'`);
    } else {
      raw = resolver(source, argsOf(field, ctx));
    }
  } catch (error) {
    ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
    return null;
  }
  return completeValue(fieldDef.type, raw, field, ctx);
}

function argsOf(field: GqlFieldNode, ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function completeValue(typeRef: string, raw: unknown, field: GqlFieldNode, ctx: GqlExecContext): unknown {
  if (raw === null || raw === undefined) return null;
  if (isListType(typeRef)) {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => completeValue(baseTypeOf(typeRef), item, field, ctx));
  }
  const base = baseTypeOf(typeRef);
  if (GQL_SCALARS.has(base) || (GQL_TYPES[base]?.kind === 'ENUM')) {
    if (base === 'Int' && typeof raw === 'number') return Math.trunc(raw);
    if (base === 'ID') return String(raw);
    return raw;
  }
  if (field.selectionSet === null) return raw;
  const source = raw as GqlSource;
  return executeSelectionSet(base === 'Node' ? source.gqlType : base, source, field.selectionSet, ctx);
}

function runGraphqlOperation(body: JsonObject): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = asObject(body.variables) ?? {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let parsed: ReturnType<GqlParser['parseDocument']>;
  try {
    parsed = new GqlParser(query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = parsed.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation found' }] };
  const vars: Record<string, unknown> = {};
  for (const [name, node] of operation.variableDefaults) vars[name] = valueOf(node, {});
  Object.assign(vars, variables);
  const ctx: GqlExecContext = { variables: vars, fragments: parsed.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const rootSource: GqlSource = { gqlType: rootType };
  const data = executeSelectionSet(rootType, rootSource, operation.selectionSet, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function handleGraphql(res: ServerResponse, raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const object = asObject(entry);
      return object === null ? { data: null, errors: [{ message: 'invalid operation' }] } : runGraphqlOperation(object);
    });
    sendJson(res, 200, results);
    return;
  }
  const object = asObject(parsed);
  if (object === null) {
    sendJson(res, 400, { errors: [{ message: 'invalid request body' }] });
    return;
  }
  sendJson(res, 200, runGraphqlOperation(object));
}

// ---------------------------------------------------------------------------------------------
// MCP (POST /mcp): JSON-RPC 2.0 over plain JSON responses. The tool list is a constant; the tools
// act on the same store as REST and GraphQL, and their results carry the REST-shaped payload both
// as text and as structured content.

const MCP_PROTOCOL_REVISION = '2026-07-28';

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner login.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function mcpRepo(args: JsonObject): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (owner !== VIEWER.login) return null;
  return repos.get(name) ?? null;
}

function mcpToolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function mcpCallTool(host: string, name: string, args: JsonObject): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '' || !/^[A-Za-z0-9._-]+$/.test(repoName)) return mcpToolError('a valid repository name is required');
      if (repos.has(repoName)) return mcpToolError('name already exists on this account');
      const repo = createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return mcpToolResult(repoJson(repo, host));
    }
    case 'get_repo': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      return mcpToolResult(repoJson(repo, host));
    }
    case 'create_issue': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return mcpToolError('title is required');
      const issue = createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'get_issue': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (issue === undefined) return mcpToolError('issue not found');
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.seq - a.seq);
      return mcpToolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || branchTip(repo, head) === undefined || branchTip(repo, base) === undefined || head === base) {
        return mcpToolError('title, an existing head branch and an existing base branch are required');
      }
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return mcpToolError('a pull request already exists for this head and base');
      const pull = createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return mcpToolResult(pullJson(repo, pull, host));
    }
    case 'list_pull_requests': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      return mcpToolResult(pulls.map((pull) => pullJson(repo, pull, host)));
    }
    case 'merge_pull_request': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return mcpToolError('pull request not found');
      if (pull.state !== 'open') return mcpToolError('Pull Request already merged');
      const analysis = analysePull(repo, pull);
      if (analysis === null || analysis.conflict) return mcpToolError('Pull Request is not mergeable');
      const sha = squashMerge(repo, pull, analysis);
      const payload = pullJson(repo, pull, host);
      payload.merge_commit_sha = sha;
      return mcpToolResult(payload);
    }
    default:
      return mcpToolError(`unknown tool ${name}`);
  }
}

function mcpRequiredArgs(toolName: string): string[] | null {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
  return tool === undefined ? null : [...tool.inputSchema.required];
}

function handleMcp(host: string, res: ServerResponse, raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = asObject(parsed);
  if (request === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = asObject(request.params) ?? {};
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  switch (method) {
    case 'server/discover': {
      reply({
        supportedVersions: ['2025-11-25', MCP_PROTOCOL_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'makefun-forge', version: '1.0.0' },
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_REVISION,
        },
      });
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      reply({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      });
      return;
    }
    case 'ping': {
      reply({});
      return;
    }
    case 'tools/list': {
      reply({ tools: MCP_TOOLS });
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const required = mcpRequiredArgs(name);
      if (required === null) {
        replyError(-32602, `unknown tool ${name}`);
        return;
      }
      const args = asObject(params.arguments) ?? {};
      for (const field of required) {
        if (args[field] === undefined || args[field] === null || args[field] === '') {
          replyError(-32602, `missing required argument ${field}`);
          return;
        }
      }
      reply(mcpCallTool(host, name, args));
      return;
    }
    default: {
      if (isNotification) {
        res.writeHead(202, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      replyError(-32601, `method not found: ${method}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The server: one dispatch over every surface, with the token check in front of all of them.

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge');
        const host = req.headers.host ?? 'localhost';
        const method = req.method ?? 'GET';
        const path = url.pathname;
        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const raw = needsBody ? await readBody(req) : Buffer.alloc(0);
        if (!authorized(req)) {
          if (path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp') {
            sendError(res, 401, 'Requires authentication');
          } else {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': nextRequestId() });
            res.end('unauthorized\n');
          }
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path.slice('/api/v3'.length).split('/').filter((segment, index) => !(index === 0 && segment === '')).map((segment) => decodeURIComponent(segment));
          const ctx: RestContext = { res, host, method, params: url.searchParams, raw };
          handleRest(ctx, path === '/api/v3' ? [] : segments);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          handleGraphql(res, raw);
          return;
        }
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          handleMcp(host, res, raw);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          handleGit(req, res, decodeURIComponent(gitMatch[1] as string), decodeURIComponent(gitMatch[2] as string), gitMatch[3] as string, raw);
          return;
        }
        sendError(res, 404, 'Not Found');
      } catch (error) {
        if (!res.headersSent) {
          try {
            sendError(res, 500, 'Internal Server Error');
          } catch {
            // The response is already gone; nothing more to do.
          }
        } else if (!res.writableEnded) {
          res.end();
        }
        void error;
      }
    })();
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}
