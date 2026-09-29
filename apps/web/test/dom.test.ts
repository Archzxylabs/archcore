/**
 * DOM tests for the transcript and the page renderer.
 *
 * These run against the DOM that Node's undici-free environment does not have,
 * so they use a minimal stand-in for the element surface the renderer touches.
 * They are unit tests of the rendering rules. They are not a browser test: no
 * real browser, wallet, or chain is involved, and nothing here is evidence of a
 * live user journey.
 *
 * What they pin down:
 *  - model and agent text is written with `textContent`, so markup in it stays
 *    text;
 *  - updating a turn that no longer has a node returns instead of throwing;
 *  - an append that the container refuses is reported, and the caller records
 *    the failure rather than crashing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChatView, render } from '../src/render.js';
import { RenterApp } from '../src/app.js';

interface FakeElement {
  tag: string;
  className: string;
  textContent: string;
  id: string;
  disabled: boolean;
  title: string;
  value: string;
  placeholder: string;
  style: { display: string };
  children: FakeElement[];
  listeners: Map<string, Array<() => void>>;
  parent: FakeElement | null;
  append(...nodes: FakeElement[]): void;
  replaceChildren(...nodes: FakeElement[]): void;
  remove(): void;
  addEventListener(event: string, listener: () => void): void;
}

function fakeElement(tag: string): FakeElement {
  const element: FakeElement = {
    tag,
    className: '',
    textContent: '',
    id: '',
    disabled: false,
    title: '',
    value: '',
    placeholder: '',
    style: { display: '' },
    children: [],
    listeners: new Map(),
    parent: null,
    append(...nodes) {
      for (const node of nodes) {
        node.parent = element;
        element.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      for (const child of element.children) child.parent = null;
      element.children = [];
      element.append(...nodes);
    },
    remove() {
      element.parent?.children.splice(element.parent.children.indexOf(element), 1);
      element.parent = null;
    },
    addEventListener(event, listener) {
      const list = element.listeners.get(event) ?? [];
      list.push(listener);
      element.listeners.set(event, list);
    },
  };
  // The renderer reads `childElementCount` the way the DOM exposes it.
  Object.defineProperty(element, 'childElementCount', { get: () => element.children.length });
  return element;
}

function installDom(): () => void {
  const previous = globalThis.document;
  const documentStub = {
    createElement: (tag: string) => fakeElement(tag),
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: documentStub,
  });
  return () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: previous,
    });
  };
}

/** Walks a fake tree collecting every node's text. */
function textsOf(node: FakeElement): string[] {
  const out = node.textContent ? [node.textContent] : [];
  for (const child of node.children) out.push(...textsOf(child));
  return out;
}

describe('ChatView', () => {
  it('writes turn text through textContent, leaving markup as text', () => {
    const restore = installDom();
    try {
      const container = fakeElement('div');
      const chat = new ChatView(container as unknown as HTMLElement);
      const payload = '<img src=x onerror=alert(1)> & <script>';

      chat.add(1, 'assistant', payload);

      const written = container.children[0]!;
      assert.equal(written.textContent, payload);
      // Nothing was parsed into a child element: the payload is one text node.
      assert.equal(written.children.length, 0);
      assert.match(written.className, /^msg assistant$/);
    } finally {
      restore();
    }
  });

  it('replaces one turn in place and leaves the others untouched', () => {
    const restore = installDom();
    try {
      const container = fakeElement('div');
      const chat = new ChatView(container as unknown as HTMLElement);
      chat.add(1, 'user', 'question');
      chat.add(2, 'assistant', '');

      chat.update(2, 'first');
      chat.update(2, 'first second');

      assert.equal(container.children[0]!.textContent, 'question');
      assert.equal(container.children[1]!.textContent, 'first second');
      assert.equal(container.children.length, 2);
    } finally {
      restore();
    }
  });

  it('does not throw when a turn is updated after its node was removed', () => {
    const restore = installDom();
    try {
      const container = fakeElement('div');
      const chat = new ChatView(container as unknown as HTMLElement);
      chat.add(1, 'assistant', 'partial');
      chat.remove(1);

      assert.doesNotThrow(() => chat.update(1, 'partial and more'));
      assert.equal(container.children.length, 0);
    } finally {
      restore();
    }
  });

  it('reports an append the container refuses instead of returning undefined', () => {
    const restore = installDom();
    try {
      const container = fakeElement('div');
      container.append = () => {
        throw new TypeError('node is gone');
      };
      const chat = new ChatView(container as unknown as HTMLElement);

      assert.throws(() => chat.add(1, 'assistant', 'answer'), /transcript could not be updated/);
    } finally {
      restore();
    }
  });
});

describe('render', { concurrency: 1 }, () => {
  it('renders model and agent text as text, never as markup', () => {
    const restore = installDom();
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost', search: '' });
      app.state = {
        ...app.state,
        config: {
          chainId: 46630,
          rpcUrl: 'https://rpc.example',
          explorerUrl: 'https://explorer.example',
          rentalManagerAddress: '0x1111111111111111111111111111111111111111',
          paymentToken: '0x6666666666666666666666666666666666666666' as `0x${string}`,
          paymentDecimals: 6,
          nodeId: 1n,
        },
        health: { status: 'degraded', checks: [{ name: 'gpu', status: 'error', detail: '<b>down</b>' }] },
        error: '<script>alert(1)</script>',
      };
      app.turns.push({ id: 1, kind: 'assistant', text: '<b>model</b>', failed: false });

      const root = fakeElement('div');
      render(root as unknown as HTMLElement, app);

      const all = textsOf(root).join('\n');
      assert.match(all, /<b>down<\/b>/);
      assert.match(all, /<script>alert\(1\)<\/script>/);
      assert.match(all, /<b>model<\/b>/);
      // No element was created from the markup: every tag name is one the
      // renderer chose itself.
      const tags = new Set<string>();
      const walk = (node: FakeElement): void => {
        tags.add(node.tag);
        node.children.forEach(walk);
      };
      walk(root);
      assert.deepEqual([...tags].filter((tag) => tag === 'script' || tag === 'img'), []);
    } finally {
      restore();
    }
  });

  it('offers no Rent button until the agent configuration has loaded', () => {
    const restore = installDom();
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost', search: '' });
      const root = fakeElement('div');
      render(root as unknown as HTMLElement, app);

      const labels = textsOf(root);
      assert.equal(labels.includes('Rent'), false);
      assert.match(labels.join(' '), /Waiting for the Agent/);
    } finally {
      restore();
    }
  });

  it('shows the wallet request as pending while the approval popup is open', () => {
    const restore = installDom();
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost', search: '' });
      app.state = { ...app.state, busy: 'Connecting wallet…' };
      const root = fakeElement('div');
      render(root as unknown as HTMLElement, app);

      const buttons: FakeElement[] = [];
      const walk = (node: FakeElement): void => {
        if (node.tag === 'button') buttons.push(node);
        node.children.forEach(walk);
      };
      walk(root);

      const connect = buttons.find((node) => node.textContent === 'Connecting…');
      assert.ok(connect, 'connect button visibly changes while awaiting the wallet');
      assert.equal(connect.disabled, true, 'duplicate wallet requests are prevented');
    } finally {
      restore();
    }
  });

  describe('state-specific inference copy and controls for all seven branches', () => {
    const ACCOUNT = '0x1111111111111111111111111111111111111111';
    const PROVIDER = '0x3333333333333333333333333333333333333333';
    const CONFIG = {
      chainId: 46630,
      rpcUrl: 'https://rpc.example',
      explorerUrl: 'https://explorer.example',
      rentalManagerAddress: '0x2222222222222222222222222222222222222222',
      paymentToken: '0x6666666666666666666666666666666666666666',
      paymentDecimals: 6,
      nodeId: 1n,
    };

    function findById(node: FakeElement, id: string): FakeElement | null {
      if (node.id === id) return node;
      for (const child of node.children) {
        const found = findById(child, id);
        if (found) return found;
      }
      return null;
    }

    function setupApp(): RenterApp {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost', search: '' });
      app.state = {
        ...app.state,
        config: CONFIG,
        account: ACCOUNT,
        wallet: { account: ACCOUNT, chainId: 46630 } as any,
        chainReady: true,
      };
      return app;
    }

    it('Branch A — AVAILABLE / no current rental', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        app.state.rental = null;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'Reserve Node 1 and wait for the provider to start the rental.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.disabled, true);
        assert.equal(authBtn.title, expected);

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true);
      } finally {
        restore();
      }
    });

    it('Branch B — RESERVED before start deadline', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'RESERVED',
          startDeadline: now + 120n,
          startsAt: 0n,
          expiresAt: 0n,
          createdAt: now,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'Waiting for the provider to start this rental. Inference becomes available only after the rental is ACTIVE.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.disabled, true);
        assert.equal(authBtn.title, expected);

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true);
      } finally {
        restore();
      }
    });

    it('Branch C — RESERVED after missed start deadline', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'RESERVED',
          startDeadline: now - 30n,
          startsAt: 0n,
          expiresAt: 0n,
          createdAt: now - 150n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'The provider missed the start deadline. Inference is unavailable; claim the full USDG refund.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.disabled, true);
        assert.equal(authBtn.title, expected);

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true);
      } finally {
        restore();
      }
    });

    it('Branch D — ACTIVE before expiresAt, no session (before popup)', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'ACTIVE',
          startDeadline: now - 60n,
          startsAt: now - 30n,
          expiresAt: now + 270n,
          createdAt: now - 60n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'Confirm access in your wallet.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.textContent, 'Authenticate rental');
        assert.equal(authBtn.disabled, false, 'Authenticate button must be enabled when ACTIVE and unauthenticated');

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true, 'Generate must remain disabled before session is authenticated');
      } finally {
        restore();
      }
    });

    it('Branch D — ACTIVE before expiresAt, authentication running', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'ACTIVE',
          startDeadline: now - 60n,
          startsAt: now - 30n,
          expiresAt: now + 270n,
          createdAt: now - 60n,
          raw: {},
        } as any;
        (app as any).authPending = true;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'Waiting for your wallet signature…';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.textContent, 'Waiting for your wallet signature…');
        assert.equal(authBtn.disabled, true, 'Authenticate button must be disabled while authentication is running');
      } finally {
        restore();
      }
    });

    it('Branch D — ACTIVE before expiresAt, authentication rejected/failed', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'ACTIVE',
          startDeadline: now - 60n,
          startsAt: now - 30n,
          expiresAt: now + 270n,
          createdAt: now - 60n,
          raw: {},
        } as any;
        app.state.authError = 'TEST wallet rejection';
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        assert.ok(allText.includes('TEST wallet rejection'), 'Expected text to include auth error');

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.textContent, 'Try authentication again');
        assert.equal(authBtn.disabled, false, 'Retry button must be enabled for manual retry');
      } finally {
        restore();
      }
    });

    it('Branch E — ACTIVE after expiresAt', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'ACTIVE',
          startDeadline: now - 400n,
          startsAt: now - 350n,
          expiresAt: now - 50n,
          createdAt: now - 400n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'This rental has expired. Inference access is closed. Automatic settlement is pending; you may settle now as a fallback.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.disabled, true);
        assert.equal(authBtn.title, expected);
        assert.notEqual(authBtn.title, 'Your own ACTIVE rental is required.');

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true);

        const settleBtn = findById(root, 'settle-rental');
        assert.ok(settleBtn, 'Settlement button must be visible for expired rental');
      } finally {
        restore();
      }
    });

    it('Branch F — CANCELLED', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'CANCELLED',
          startDeadline: now - 100n,
          startsAt: 0n,
          expiresAt: 0n,
          createdAt: now - 200n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'This rental was cancelled and refunded. Node 1 may be rented again after the authoritative occupancy read clears.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.disabled, true);
        assert.equal(authBtn.title, expected);

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true);
      } finally {
        restore();
      }
    });

    it('Branch G — COMPLETED', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 1n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'COMPLETED',
          startDeadline: now - 500n,
          startsAt: now - 400n,
          expiresAt: now - 100n,
          createdAt: now - 500n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        const expected = 'This rental was settled. Node 1 may be rented again after the authoritative occupancy read clears.';
        assert.ok(allText.includes(expected), `Expected text to include: "${expected}"`);

        const authBtn = findById(root, 'authenticate-rental');
        assert.ok(authBtn);
        assert.equal(authBtn.disabled, true);
        assert.equal(authBtn.title, expected);

        const genBtn = findById(root, 'generate-inference');
        assert.ok(genBtn);
        assert.equal(genBtn.disabled, true);

        // Settlement CTA button must not be present when rental is COMPLETED
        const settleBtn = findById(root, 'settle-rental');
        assert.equal(settleBtn, null, 'Settlement CTA must disappear when COMPLETED');
      } finally {
        restore();
      }
    });

    it('confirms settlement CTA disappears and lifecycle shows COMPLETED', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 7n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'COMPLETED',
          startDeadline: now - 500n,
          startsAt: now - 400n,
          expiresAt: now - 100n,
          createdAt: now - 500n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        assert.ok(allText.includes('Rental #7 · Plan 1 · COMPLETED'));
        assert.ok(allText.includes('100% escrow paid to the frozen provider. Node is released after chain confirmation.'));

        const settleBtn = findById(root, 'settle-rental');
        assert.equal(settleBtn, null, 'Settlement CTA must disappear when COMPLETED');
      } finally {
        restore();
      }
    });

    it('does not let another wallet\'s terminal rental history block an available node', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const previousRenter = '0x9999999999999999999999999999999999999999';
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 8n,
          nodeId: 1n,
          planId: 0,
          renter: previousRenter,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'COMPLETED',
          startDeadline: now - 500n,
          startsAt: now - 400n,
          expiresAt: now - 100n,
          createdAt: now - 500n,
          raw: {},
        } as any;
        app.state.quote = {
          nodeId: 1n,
          planId: 1,
          priceAtomic: 6_000_000n,
          durationSeconds: 21_600n,
          available: true,
        } as any;
        app.state.payment = {
          address: CONFIG.paymentToken,
          decimals: 6,
          symbol: 'USDG',
          balance: 0n,
          allowance: 0n,
        } as any;
        app.state.gasBalance = 1_000_000_000_000_000_000n;

        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        assert.ok(allText.includes('Insufficient USDG balance for this plan.'));
        assert.equal(allText.includes('Node 1 is occupied or unavailable.'), false);
        const approve = findById(root, 'approve-usdg');
        assert.ok(approve);
        assert.equal(approve.disabled, true);
        assert.equal(approve.title, 'Insufficient USDG balance for this plan.');
      } finally {
        restore();
      }
    });

    it('ACTIVE before expiry displays automatic-settlement explanation', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 3n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'ACTIVE',
          startDeadline: now - 60n,
          startsAt: now - 30n,
          expiresAt: now + 270n,
          createdAt: now - 60n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        assert.ok(
          allText.includes('Settlement will be submitted automatically after expiry.'),
          'Expected lifecycle panel to include auto-settlement explanation before expiry',
        );

        // Settle button must NOT appear before expiry
        const settleBtn = findById(root, 'settle-rental');
        assert.equal(settleBtn, null, 'Settle button must not appear before expiry');
      } finally {
        restore();
      }
    });

    it('expired ACTIVE displays automatic-pending copy and manual fallback', () => {
      const restore = installDom();
      try {
        const app = setupApp();
        const now = BigInt(Math.floor(Date.now() / 1000));
        app.state.rental = {
          rentalId: 4n,
          nodeId: 1n,
          planId: 1,
          renter: ACCOUNT,
          provider: PROVIDER,
          priceAtomic: 100_000n,
          durationSeconds: 300n,
          status: 'ACTIVE',
          startDeadline: now - 400n,
          startsAt: now - 350n,
          expiresAt: now - 50n,
          createdAt: now - 400n,
          raw: {},
        } as any;
        const root = fakeElement('div');
        render(root as unknown as HTMLElement, app);

        const allText = textsOf(root).join(' ');
        assert.ok(
          allText.includes('Automatic settlement pending. You may settle now as a permissionless fallback.'),
          'Expected lifecycle panel to include auto-settlement pending copy',
        );

        // Manual fallback button must show "Settle now"
        const settleBtn = findById(root, 'settle-rental');
        assert.ok(settleBtn, 'Manual settle fallback button must be visible');
        assert.equal(settleBtn.textContent, 'Settle now', 'Button text must be "Settle now"');
      } finally {
        restore();
      }
    });
  });
});
