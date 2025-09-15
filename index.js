const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

let browser;
let idleTimeout;

// Configuration
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

function scheduleBrowserShutdown() {
  // Clear existing timeout
  if (idleTimeout) {
    clearTimeout(idleTimeout);
  }

  // Schedule new shutdown
  idleTimeout = setTimeout(async () => {
    if (browser) {
      console.log("Browser idle for 5 minutes, shutting down...");
      await browser.close();
      browser = null;
      console.log("Browser shut down successfully");
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
    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    console.log("Browser launched successfully");
  }
  return browser;
}

app.get("/screenshot", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url parameter");

  let page;
  try {
    // Cancel any pending shutdown
    cancelBrowserShutdown();

    // Validate URL
    new URL(url);

    const browser = await initBrowser();
    page = await browser.newPage();

    // Set viewport for consistent screenshots
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const buffer = await page.screenshot({ fullPage: true, type: "png" });

    res.set("Content-Type", "image/png");
    res.send(buffer);
  } catch (err) {
    console.error(err);
    if (err.code === "ERR_INVALID_URL") {
      res.status(400).send("Invalid URL");
    } else {
      res.status(500).send("Error taking screenshot");
    }
  } finally {
    if (page) {
      await page.close();
    }
    scheduleBrowserShutdown(); // Reschedule browser shutdown on request completion
  }
});

app.get("/", (req, res) => {
  res.send("Screenshot API is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// Graceful shutdown
process.on("SIGINT", async () => {
  cancelBrowserShutdown();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});
