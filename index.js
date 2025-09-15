const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

let browser;
let idleTimeout;

// Configuration
const IDLE_TIMEOUT = process.env.IDLE_TIMEOUT
  ? parseInt(process.env.IDLE_TIMEOUT)
  : 3 * 60 * 1000; // 3 minutes default
let lastActivity = Date.now();

function scheduleBrowserShutdown() {
  // Clear existing timeout
  if (idleTimeout) {
    clearTimeout(idleTimeout);
  }

  // Schedule new shutdown
  idleTimeout = setTimeout(async () => {
    if (browser && Date.now() - lastActivity >= IDLE_TIMEOUT) {
      console.log(
        `Browser idle for ${IDLE_TIMEOUT / 1000} seconds, shutting down...`
      );
      try {
        await browser.close();
        browser = null;
        console.log("Browser shut down successfully to save resources");
      } catch (err) {
        console.error("Error closing browser:", err);
        browser = null; // Reset browser reference even if close fails
      }
    }
  }, IDLE_TIMEOUT);
}

function cancelBrowserShutdown() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
    idleTimeout = null;
  }
}

async function initBrowser() {
  if (!browser) {
    console.log("Launching optimized browser...");
    try {
      // Try to find Chrome executable path
      let executablePath = null;
      
      // For Render deployment
      if (process.env.RENDER) {
        // Try to find installed Chrome
        const fs = require('fs');
        const possiblePaths = [
          '/opt/render/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome'
        ];
        
        for (const path of possiblePaths) {
          if (fs.existsSync && fs.existsSync(path)) {
            executablePath = path;
            console.log(`Found Chrome at: ${path}`);
            break;
          }
        }
      }

      const launchOptions = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--single-process",
          "--no-zygote"
        ],
      };

      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }

      browser = await puppeteer.launch(launchOptions);
      console.log("Browser launched successfully with memory optimizations");

      // Handle browser disconnection
      browser.on("disconnected", () => {
        console.log("Browser disconnected, clearing reference");
        browser = null;
      });
    } catch (err) {
      console.error("Failed to launch browser:", err);
      browser = null;
      throw new Error("Browser launch failed: " + err.message);
    }
  }
  return browser;
}

app.get("/screenshot", async (req, res) => {
  const startTime = Date.now();
  lastActivity = startTime;

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  let page;
  try {
    // Cancel any pending shutdown
    cancelBrowserShutdown();

    // Validate URL
    new URL(url);

    const browser = await initBrowser();
    page = await browser.newPage();

    // Optimize memory usage
    await page.setViewport({
      width: parseInt(req.query.width) || 1280,
      height: parseInt(req.query.height) || 720,
    });

    // Set page optimizations
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    // Block unnecessary resources to speed up loading (ปิดชั่วคราวเพื่อ debug)
    // await page.setRequestInterception(true);
    // page.on("request", (req) => {
    //   const resourceType = req.resourceType();
    //   if (["stylesheet", "font", "image"].includes(resourceType)) {
    //     req.abort();
    //   } else {
    //     req.continue();
    //   }
    // });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    // Wait a bit for dynamic content
    await page.waitForTimeout(1000);

    const buffer = await page.screenshot({
      fullPage: req.query.fullPage !== "false",
      type: "png",
      quality: 90,
    });

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
    res.send(buffer);

    const duration = Date.now() - startTime;
    console.log(`Screenshot completed in ${duration}ms for ${url}`);
  } catch (err) {
    console.error(`Screenshot error for ${url}:`, err);

    // Reset browser if it's corrupted
    if (
      browser &&
      (err.message.includes("Target closed") ||
        err.message.includes("Protocol error"))
    ) {
      console.log("Browser corrupted, resetting...");
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Error closing corrupted browser:", closeErr);
      }
      browser = null;
    }

    if (err.code === "ERR_INVALID_URL") {
      res.status(400).json({ error: "Invalid URL provided" });
    } else if (err.name === "TimeoutError") {
      res
        .status(408)
        .json({ error: "Request timeout - page took too long to load" });
    } else if (
      err.message.includes("Navigation failed") ||
      err.message.includes("net::ERR_")
    ) {
      res.status(400).json({ error: "Unable to access the provided URL" });
    } else if (
      err.message.includes("Target closed") ||
      err.message.includes("Protocol error")
    ) {
      res
        .status(503)
        .json({
          error: "Browser service temporarily unavailable, please retry",
        });
    } else {
      console.error("Full error details:", {
        message: err.message,
        stack: err.stack,
        name: err.name,
        url: url,
      });
      res.status(500).json({
        error: "Internal server error while taking screenshot",
        details:
          process.env.NODE_ENV === "development" ? err.message : undefined,
      });
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (err) {
        console.error("Error closing page:", err);
      }
    }
    lastActivity = Date.now();
    scheduleBrowserShutdown(); // Reschedule browser shutdown on request completion
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  const status = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + "MB",
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + "MB",
    },
    browserActive: !!browser,
    lastActivity: new Date(lastActivity).toISOString(),
  };
  res.json(status);
});

// Status endpoint for monitoring
app.get("/status", (req, res) => {
  res.json({
    service: "Screenshot API",
    version: "1.0.0",
    status: "running",
    endpoints: [
      "GET /screenshot?url=<URL>&width=<WIDTH>&height=<HEIGHT>&fullPage=<true/false>",
      "GET /health",
      "GET /status",
    ],
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Screenshot API is running",
    usage: "GET /screenshot?url=https://example.com",
    health: "/health",
    status: "/status",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Screenshot API listening on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  cancelBrowserShutdown();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});
