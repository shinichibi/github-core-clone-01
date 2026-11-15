// Entry point for the trial pod. The harness contract is small: the environment names itself in
// $MAKEFUN_ENV_URL, this process starts the forge on an ephemeral port, tells the environment
// where it landed, and stays alive until the environment says the trial is done.
//
// Registration is retried with a growing delay: the environment's register endpoint may not be
// listening yet when a fast entry boots, and a 409 only means it already has the port.

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRegister(envUrl: string, port: number): Promise<void> {
  let delayMs = 250;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
    } catch {
      // The environment is not up yet; fall through to the retry delay.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2_000);
  }
}

async function waitUntilDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll is not the end of the trial; keep waiting.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('[entry] MAKEFUN_ENV_URL is not set; exiting');
    process.exit(1);
  }
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('[entry] the server did not bind a port; exiting');
    process.exit(1);
  }
  console.log(`[entry] listening on port ${address.port}`);
  await postRegister(envUrl, address.port);
  console.log('[entry] registered; waiting for the env to say done');
  await waitUntilDone(envUrl);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

void main();
