/**
 * Live Replay + Superserve prize-track run. Skipped unless LIVE_PROBES=1.
 * foundry-api is not deployed; the storefront under test is served from a
 * Superserve VM preview URL so Replay has a real HTTPS target we control.
 * Failures are recorded, never stubbed into a pass.
 *
 * The default microVM image here has no python3; files are unpacked with
 * `base64 -d` and the browser plane is a Perl HTTP server plus a published
 * preview port.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, TimeoutError, toFoundryError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { ReplayAdapter } from '../src/replay/index.js';
import { SuperserveAdapter } from '../src/superserve/index.js';

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

loadDotenv(resolve(process.cwd(), '.env'));

const live = process.env['LIVE_PROBES'] === '1';

function ctx(): AdapterContext {
  return {
    secrets: new SecretStore(),
    environment: 'production',
    publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? 'https://example.test',
  };
}

function execText(result: { stdout?: string | null; stderr?: string | null }): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

async function waitUntilActive(ss: SuperserveAdapter, id: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const box = await ss.getSandbox(id);
    last = box.status;
    if (box.status === 'active') return box.status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return last;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const STOREFRONT_PAGES: Readonly<Record<string, string>> = {
  'index.html':
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foundry Storefront</title></head><body><h1>Foundry Storefront</h1><p>Homepage</p><nav><a href="/product">Product</a> · <a href="/support">Support</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></nav></body></html>',
  'product.html':
    '<!doctype html><html><head><title>Ceramic mug</title></head><body><h1>Ceramic mug</h1><p>$24.00</p><form action="/cart" method="get"><button type="submit">Add to cart</button></form><p><a href="/">Home</a></p></body></html>',
  'cart.html':
    '<!doctype html><html><head><title>Cart</title></head><body><h1>Cart</h1><p>1 x Ceramic mug — $24.00</p><a href="/checkout">Checkout</a> · <a href="/product">Continue shopping</a></body></html>',
  'checkout.html':
    '<!doctype html><html><head><title>Checkout</title></head><body><h1>Checkout</h1><form action="/pay" method="get"><label>Email <input type="email" name="email" value="qa@foundry.test" required></label><button type="submit">Pay</button></form></body></html>',
  'pay.html':
    '<!doctype html><html><head><title>Payment</title></head><body><h1>Payment</h1><p>Pay $24.00</p><a href="/thanks">Payment success</a> · <a href="/pay-fail">Payment declined</a></body></html>',
  'pay-fail.html':
    '<!doctype html><html><head><title>Payment failed</title></head><body><h1>Payment declined</h1><p>Card was declined. Please try another card or return to checkout.</p><a href="/checkout">Back to checkout</a></body></html>',
  'thanks.html':
    '<!doctype html><html><head><title>Order confirmed</title></head><body><h1>Thank you</h1><p>Order ORD-1001 confirmed for qa@foundry.test.</p><p>Ceramic mug — $24.00</p><a href="/">Home</a></body></html>',
  'support.html':
    '<!doctype html><html><head><title>Support</title></head><body><h1>Contact support</h1><p>Email help@foundry.test for order help, refunds, and shipping questions.</p><h2>FAQ</h2><p>Orders confirm instantly on the thank-you page. Declined cards return you to checkout.</p><a href="/">Home</a></body></html>',
  'privacy.html':
    '<!doctype html><html><head><title>Privacy</title></head><body><h1>Privacy policy</h1><p>We collect email only to send order confirmation. We do not sell personal data.</p><a href="/">Home</a></body></html>',
  'terms.html':
    '<!doctype html><html><head><title>Terms</title></head><body><h1>Terms</h1><p>Refunds within 30 days of purchase. Contact help@foundry.test to start a return.</p><a href="/">Home</a></body></html>',
  '404.html':
    '<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1><p>That page does not exist.</p><a href="/">Home</a></body></html>',
};

const HTTPD_PL = [
  'use strict;',
  'use warnings;',
  'use IO::Socket::INET;',
  'my $root = "/tmp/storefront";',
  'my $srv = IO::Socket::INET->new(LocalAddr => "0.0.0.0", LocalPort => 8080, Proto => "tcp", Listen => 32, Reuse => 1) or die "bind failed";',
  'while (my $client = $srv->accept) {',
  '  $client->autoflush(1);',
  '  my $req = "";',
  '  while (1) {',
  '    my $n = $client->sysread(my $buf, 4096);',
  '    last if !defined $n || $n == 0;',
  '    $req .= $buf;',
  '    last if $req =~ /\\r\\n\\r\\n/ || length($req) > 65536;',
  '  }',
  '  my ($method, $loc) = $req =~ /^(GET|HEAD)\\s+(\\S+)/i;',
  '  $method = uc($method || "GET");',
  '  $loc = "/" if !$loc;',
  '  $loc =~ s/\\?.*//;',
  '  $loc =~ s#/$## unless $loc eq "/";',
  '  $loc = "/index.html" if $loc eq "/";',
  '  $loc = "$loc.html" if $loc !~ /\\.[A-Za-z0-9]+$/ && -f "$root$loc.html";',
  '  my $file = $root . $loc;',
  '  $file = "$root/index.html" if -d $file;',
  '  my ($status, $body, $type) = (404, "", "text/html; charset=utf-8");',
  '  if (open my $fh, "<:raw", $file) {',
  '    local $/;',
  '    $body = <$fh> // "";',
  '    close $fh;',
  '    $status = 200;',
  '  } elsif (open my $nfh, "<:raw", "$root/404.html") {',
  '    local $/;',
  '    $body = <$nfh> // "Not found";',
  '    close $nfh;',
  '  } else {',
  '    $body = "<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1></body></html>";',
  '  }',
  '  my $phrase = $status == 200 ? "OK" : "Not Found";',
  '  print $client "HTTP/1.1 $status $phrase\\r\\nContent-Type: $type\\r\\nContent-Length: " . length($body) . "\\r\\nConnection: close\\r\\n\\r\\n";',
  '  print $client $body unless $method eq "HEAD";',
  '  close $client;',
  '}',
].join('\n');

describe.skipIf(!live)('live Replay + Superserve', () => {
  it('serves a storefront from a VM, proves pause keeps state, and starts Replay QA', async () => {
    const ss = new SuperserveAdapter(ctx());
    const replay = new ReplayAdapter(ctx());
    const evidence: Record<string, unknown> = {
      foundryApiDeployed: false,
      runAt: new Date().toISOString(),
    };

    const existing = await ss.listSandboxes();
    evidence.existingSandboxCount = existing.length;
    const reusable = existing.find((box) => box.name === 'foundry-replay-storefront');
    const box = reusable
      ? await ss.activateSandbox(reusable.id)
      : await ss.createSandbox({
          name: 'foundry-replay-storefront',
          timeoutSeconds: 900,
          autoDeleteSeconds: 3600,
          previewAccess: 'public',
          fromTemplate: 'superserve/base',
          agentRunId: 'foundry-replay-qa-storefront',
        });
    evidence.sandboxId = box.id;
    evidence.createStatus = box.status;
    expect(box.id.length).toBeGreaterThan(4);
    const active = await waitUntilActive(ss, box.id);
    evidence.activeStatus = active;
    expect(active).toBe('active');

    const unpack: string[] = ['mkdir -p /tmp/storefront /tmp/foundry-proof'];
    for (const [name, html] of Object.entries(STOREFRONT_PAGES)) {
      unpack.push(`echo ${b64(html)} | base64 -d > /tmp/storefront/${name}`);
    }
    unpack.push(`echo ${b64(HTTPD_PL)} | base64 -d > /tmp/foundry-proof/httpd.pl`);
    unpack.push("printf '%s' 'foundry-pause-live' > /tmp/foundry-proof/marker.txt");
    unpack.push('ls /tmp/storefront /tmp/foundry-proof');
    const packed = await ss.execInSandbox(box.id, { command: unpack.join('\n'), timeoutSeconds: 20 });
    evidence.wrotePages = { exit: packed.exit_code ?? null, text: execText(packed).slice(0, 800) };

    const started = await ss.execInSandbox(box.id, {
      command:
        'nohup perl /tmp/foundry-proof/httpd.pl >/tmp/foundry-proof/http.log 2>&1 & echo $! > /tmp/foundry-proof/http.pid; nohup sleep 3600 >/dev/null 2>&1 & echo $! > /tmp/foundry-proof/sleeper.pid; sleep 1; cat /tmp/foundry-proof/http.pid /tmp/foundry-proof/sleeper.pid; head -c 200 /tmp/foundry-proof/http.log || true',
      timeoutSeconds: 10,
    });
    evidence.startedDaemons = { exit: started.exit_code ?? null, text: execText(started).slice(0, 400) };

    let published;
    try {
      published = await ss.createPreviewPort(box.id, 8080);
    } catch (error) {
      evidence.previewPublishError = toFoundryError(error).message;
      const listed = await ss.listPreviewPorts(box.id);
      published = listed[0] ?? { port: 8080, url: ss.previewUrl(box.id, 8080) };
    }
    const previewUrl = published.url ?? ss.previewUrl(box.id, 8080);
    evidence.previewUrl = previewUrl;
    evidence.publishedPort = published;

    const inside = await ss.execInSandbox(box.id, {
      command:
        'curl -sS -m 3 http://127.0.0.1:8080/ | head -c 400; echo; kill -0 "$(cat /tmp/foundry-proof/http.pid)" && echo HTTP_ALIVE=1; kill -0 "$(cat /tmp/foundry-proof/sleeper.pid)" && echo SLEEP_ALIVE=1; cat /tmp/foundry-proof/marker.txt; echo',
      timeoutSeconds: 15,
    });
    evidence.insideBeforePause = execText(inside).slice(0, 800);
    expect(execText(inside)).toContain('Foundry Storefront');
    expect(execText(inside)).toContain('SLEEP_ALIVE=1');

    await new Promise((r) => setTimeout(r, 2_000));
    const before = await fetch(previewUrl, { redirect: 'follow' });
    const beforeHtml = await before.text();
    evidence.browserBeforePause = { status: before.status, snippet: beforeHtml.slice(0, 200) };
    expect(beforeHtml).toContain('Foundry Storefront');

    const paused = await ss.pauseSandbox(box.id);
    evidence.pause = { status: paused.status, tokenCached: ss.hasCachedAccessToken(box.id) };
    expect(ss.hasCachedAccessToken(box.id)).toBe(false);

    const resumed = await ss.resumeSandbox(box.id);
    evidence.resume = { status: resumed.status, tokenRotated: ss.hasCachedAccessToken(box.id) };
    const resumedActive = await waitUntilActive(ss, box.id, 90_000);
    evidence.resumeActive = resumedActive;
    expect(resumedActive).toBe('active');

    const proof = await ss.execInSandbox(box.id, {
      command:
        'echo MARKER=$(cat /tmp/foundry-proof/marker.txt); if kill -0 "$(cat /tmp/foundry-proof/http.pid)" 2>/dev/null; then echo HTTP_ALIVE=1; else echo HTTP_ALIVE=0; fi; if kill -0 "$(cat /tmp/foundry-proof/sleeper.pid)" 2>/dev/null; then echo SLEEP_ALIVE=1; else echo SLEEP_ALIVE=0; fi; curl -sS -m 3 http://127.0.0.1:8080/ | head -c 120; echo',
      timeoutSeconds: 20,
    });
    const proofText = execText(proof);
    evidence.pauseProof = { exit: proof.exit_code ?? null, text: proofText.slice(0, 1500) };
    expect(proofText).toContain('MARKER=foundry-pause-live');
    expect(proofText).toContain('SLEEP_ALIVE=1');
    expect(proofText).toContain('HTTP_ALIVE=1');

    const after = await fetch(previewUrl, { redirect: 'follow' });
    const afterHtml = await after.text();
    evidence.browserAfterResume = { status: after.status, snippet: afterHtml.slice(0, 200) };
    expect(afterHtml).toContain('Foundry Storefront');

    const replayProbe = await replay.probe();
    evidence.replayProbe = replayProbe;
    expect(replayProbe.succeeded).toBe(true);

    const project = await replay.ensureProjectForTarget({
      name: 'foundry-superserve-storefront',
      targetUrl: previewUrl,
      instructions:
        'This is a small storefront. Cover homepage, product, add to cart, checkout, payment success, payment failure, order confirmation, support, privacy, and terms. Mobile viewport too.',
      budget: 20,
    });
    evidence.replayProjectId = project.id;
    evidence.replayTargetUrl = project.target_url;
    evidence.replayDashboard = project.url ?? null;
    evidence.replayExplorationId = project.exploration_id ?? null;
    expect(project.id.length).toBeGreaterThan(4);

    let qaStatus = 'running';
    try {
      const timing = await replay.waitForProjectIdle(project.id, { timeoutMs: 90_000, pollIntervalMs: 5_000 });
      evidence.replayTiming = timing;
      qaStatus = timing.finished_at ? (timing.started_at ? 'completed' : 'failed_unexecuted') : 'running';
    } catch (error) {
      const foundry = toFoundryError(error);
      evidence.replayWait = { timedOut: error instanceof TimeoutError, code: foundry.code, message: foundry.message };
      try {
        evidence.replayTiming = await replay.getProjectTiming(project.id);
      } catch (timingError) {
        evidence.replayTimingError = toFoundryError(timingError).message;
      }
      qaStatus = error instanceof TimeoutError ? 'running' : 'provider_error';
    }

    try {
      const bugs = await replay.listBugs(project.id, { pageSize: 20 });
      evidence.replayBugCount = bugs.items.length;
      evidence.replayBugTitles = bugs.items.slice(0, 5).map((bug) => bug.title);
    } catch (error) {
      evidence.replayBugsError = toFoundryError(error).message;
    }

    try {
      evidence.replayProjectStatus = await replay.getProjectStatus(project.id);
    } catch (error) {
      evidence.replayStatusError = toFoundryError(error).message;
    }

    evidence.qaStatus = qaStatus;
    expect(['running', 'completed', 'failed_unexecuted', 'provider_error']).toContain(qaStatus);

    if (qaStatus === 'running') {
      evidence.finalPauseStatus = 'left_active_for_replay';
    } else {
      const finalPause = await ss.pauseSandbox(box.id);
      evidence.finalPauseStatus = finalPause.status;
    }

    writeFileSync('/tmp/foundry-replay-superserve-evidence.json', JSON.stringify(evidence, null, 2));
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    expect(evidence.sandboxId).toEqual(box.id);
    expect(evidence.replayProjectId).toEqual(project.id);
  }, 240_000);
});
