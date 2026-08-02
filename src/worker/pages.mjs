// Decoy page served to anything that isn't a valid WebSocket upgrade on the
// configured path. Kept byte-identical to the Node build's FAKE_INDEX_HTML so
// both deployments present the same cover site.

export const FAKE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f7fa;
            color: #2c3e50;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        header {
            text-align: center;
            padding: 60px 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            margin-bottom: 40px;
            border-radius: 12px;
        }
        header h1 { font-size: 2.5em; margin-bottom: 10px; }
        header p { font-size: 1.2em; opacity: 0.9; }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            margin-bottom: 40px;
        }
        .feature-card {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            transition: transform 0.2s;
        }
        .feature-card:hover { transform: translateY(-5px); }
        .feature-card h3 { color: #667eea; margin-bottom: 10px; }
        .cta {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
        }
        .btn {
            display: inline-block;
            padding: 12px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            margin: 10px;
            transition: background 0.2s;
        }
        .btn:hover { background: #5a67d8; }
        footer { text-align: center; padding: 40px 0; color: #7f8c8d; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Welcome to Our Service</h1>
            <p>Reliable, fast, and secure solutions for your needs</p>
        </header>
        <div class="features">
            <div class="feature-card">
                <h3>High Performance</h3>
                <p>Built with cutting-edge technology to ensure the best experience with minimal latency and maximum throughput.</p>
            </div>
            <div class="feature-card">
                <h3>Secure & Private</h3>
                <p>Your data security is our top priority. We use industry-standard encryption to protect all communications.</p>
            </div>
            <div class="feature-card">
                <h3>Global Network</h3>
                <p>Access our services from anywhere in the world with our distributed network infrastructure.</p>
            </div>
        </div>
        <div class="cta">
            <h2>Get Started Today</h2>
            <p>Join thousands of satisfied users who trust our platform.</p>
            <a href="#" class="btn">Learn More</a>
            <a href="#" class="btn">Contact Us</a>
        </div>
        <footer>
            <p> Contact 2026 Our Service. All rights reserved.</p>
        </footer>
    </div>
</body>
</html>`;

export function decoyResponse() {
  return new Response(FAKE_INDEX_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate'
    }
  });
}
