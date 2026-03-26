#!/usr/bin/env ts-node
/**
 * ios-webkit-debug-proxy Proof of Concept
 *
 * Prerequisites:
 *   brew install ios-webkit-debug-proxy
 *   xcrun simctl boot "iPhone 16"
 *   xcrun simctl openurl booted "https://example.com"
 *   ios_webkit_debug_proxy
 *
 * Then run: npx ts-node spike/iwdp-poc.ts
 */

import WebSocket from 'ws';
import http from 'http';

async function main() {
  // 1. List targets
  console.log('Listing targets...');
  const targetsJson = await httpGet('http://localhost:9222/json');
  const targets = JSON.parse(targetsJson);
  console.log(`Found ${targets.length} targets:`);
  targets.forEach((t: any) => console.log(`  - ${t.title} (${t.url})`));

  if (targets.length === 0) {
    console.error('No targets found. Is Safari open in the simulator?');
    process.exit(1);
  }

  // 2. Connect to first target
  const target = targets[0];
  const wsUrl = target.webSocketDebuggerUrl;
  console.log(`\nConnecting to: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('Connected!\n');

    // 3. Send Runtime.evaluate
    const msg = JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true },
    });
    console.log(`Sending: ${msg}`);
    ws.send(msg);
  });

  ws.on('message', (data: WebSocket.Data) => {
    const response = JSON.parse(data.toString());
    console.log(`Received: ${JSON.stringify(response, null, 2)}`);

    if (response.id === 1) {
      console.log(
        `\nSuccess! document.title = "${response.result?.result?.value}"`,
      );
      ws.close();
      process.exit(0);
    }
  });

  ws.on('error', (err: Error) => {
    console.error('WebSocket error:', err.message);
    process.exit(1);
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

main();
