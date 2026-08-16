'use strict';

// Decoy page served to anything that is not a valid WebSocket upgrade on the
// configured path.
//
// Shared by BOTH builds: the Node server (src/node/pages.js) and the Cloudflare
// Worker (src/worker/pages.mjs) import it from here, so the two deployments
// cannot drift into presenting different cover sites. CommonJS on purpose —
// wrangler's bundler pulls it into the ESM worker via a default import, the
// same bridge src/vless.js uses.
//
// Styled with classless Pico from jsDelivr: the markup below carries no
// framework class names, so it reads like hand-written HTML. The tradeoff is
// deliberate and accepted — this page makes one outbound request, and on a
// network that blocks the CDN it renders unstyled.
//
// Two constraints on edits, both of which fail confusingly:
//   * this is a template literal, so the markup must contain no backtick and
//     no ${ ;
//   * nothing here may require() or touch a Node built-in, or the Worker build
//     stops bundling without a nodejs_compat flag.

const FAKE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Northwind Systems</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css">
    <style>
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
        .features article { margin: 0; }
        .cta { text-align: center; }
    </style>
</head>
<body>
    <nav>
        <ul>
            <li><strong>Northwind Systems</strong></li>
        </ul>
        <ul>
            <li><a href="#">Products</a></li>
            <li><a href="#">Pricing</a></li>
            <li><a href="#">Support</a></li>
        </ul>
    </nav>
    <main>
        <header>
            <h1>Infrastructure that stays out of your way</h1>
            <p>Reliable, fast and secure managed services for teams that would rather ship than maintain.</p>
        </header>
        <section class="features">
            <article>
                <h3>High performance</h3>
                <p>Built on modern infrastructure for minimal latency and consistent throughput, wherever your users are.</p>
            </article>
            <article>
                <h3>Secure by default</h3>
                <p>Encryption in transit and at rest on every plan, with no configuration required and no surprises later.</p>
            </article>
            <article>
                <h3>Global network</h3>
                <p>Distributed points of presence keep response times low without you having to think about regions.</p>
            </article>
        </section>
        <section class="cta">
            <h2>Get started today</h2>
            <p>Join thousands of teams already running on Northwind.</p>
            <a href="#" role="button">Learn more</a>
            <a href="#" role="button" class="secondary">Contact sales</a>
        </section>
    </main>
    <footer>
        <small>&copy; 2026 Northwind Systems. All rights reserved.</small>
    </footer>
</body>
</html>`;

module.exports = { FAKE_INDEX_HTML };
