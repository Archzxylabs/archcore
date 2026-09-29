/**
 * Renter entry point.
 *
 * This module owns almost nothing: it constructs the controller, subscribes the
 * DOM renderer, and starts it. Its only real job is making sure a failure during
 * boot reaches the user as a readable page rather than a blank one.
 */

import { RenterApp } from './app';
import { render } from './render';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('The renter page is missing its #app root element.');
  }

  const app = new RenterApp({
    hostname: window.location.hostname,
    origin: window.location.origin,
    search: window.location.search,
  });

  app.subscribe(() => render(root, app));

  // Leaving the page has to revoke the session, not just stop the ticker.
  // `pagehide` is the one that fires reliably on mobile and when a
  // back/forward-cache restore happens; `beforeunload` covers a desktop tab
  // being closed. Registering neither left the token in memory after the renter
  // had navigated away, which is the one exit the controller cannot see itself.
  const teardown = () => app.stop();
  window.addEventListener('pagehide', teardown);
  window.addEventListener('beforeunload', teardown);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void app.start().catch((error: unknown) => app.reportFailure(error));
  });

  app.start().catch((error: unknown) => {
    // Rendering here matters more than the message: the page must not be left
    // blank when boot fails, because a blank page reads as "still loading".
    app.state = { ...app.state, error: `Could not start the renter: ${String(error)}`, busy: null };
    render(root, app);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
