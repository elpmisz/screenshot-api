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
        const fs = require("fs");
        const path = require("path");

        console.log("Searching for Chrome executable...");

        // Use system Chrome from environment or fallback
        executablePath =
          process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
        console.log(`Using system Chrome: ${executablePath}`);

        // Verify the file exists
        if (!fs.existsSync(executablePath)) {
          console.log(
            `Chrome not found at ${executablePath}, searching alternatives...`
          );

          const alternatives = [
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
          ];

          for (const alt of alternatives) {
            console.log(`Checking: ${alt}`);
            if (fs.existsSync(alt)) {
              executablePath = alt;
              console.log(`Found alternative Chrome: ${alt}`);
              break;
            }
          }

          // If still not found, let Puppeteer try its default
          if (!fs.existsSync(executablePath)) {
            console.log("No system Chrome found, trying Puppeteer default...");
            executablePath = null;
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
          "--no-zygote",
        ],
      };

      if (executablePath) {
        launchOptions.executablePath = executablePath;
        console.log(`Using Chrome executable: ${executablePath}`);
      } else {
        console.log(
          "No Chrome executable found, letting Puppeteer try default..."
        );
      }

      console.log("Launch options:", JSON.stringify(launchOptions, null, 2));
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

    // Set page optimizations for better compatibility
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Enable JavaScript (important for dashboard sites)
    await page.setJavaScriptEnabled(true);

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

    // Navigate with better wait conditions for heavy JS pages
    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    // Smart loading detection - wait until page is actually ready
    const maxWaitTime = parseInt(req.query.wait) || 30000; // Max 30 seconds if specified
    console.log(`Waiting up to ${maxWaitTime}ms for page to be fully ready...`);

    try {
      // Try smart loading detection first
      try {
        await page.waitForFunction(
          () => {
            // Check for common loading states
            const loadingIndicators = [
              // Google Looker Studio
              ".loading-spinner",
              ".report-loading",
              '[data-loading="true"]',
              // General loading indicators
              ".loading",
              ".spinner",
              ".loader",
              '[aria-busy="true"]',
              ".MuiCircularProgress-root",
              // CoinMarketCap specific
              ".cmc-loader",
              ".spinner-wrapper",
              ".loading-overlay",
              ".skeleton-loading",
              ".table-loading",
              ".price-loading",
              // Wait for main content to be visible
              ".report-container",
              ".dashboard-content",
              "main",
              ".content",
              // Additional common selectors
              ".chart-container",
              ".price-chart",
              ".market-data",
              ".crypto-table",
              ".coin-stats",
            ];

            // Check if any loading indicators are present
            const hasLoading = loadingIndicators.some((sel) => {
              const el = document.querySelector(sel);
              return (
                el &&
                (el.offsetHeight > 0 || el.getAttribute("aria-busy") === "true")
              );
            });

            // Check if page has meaningful content
            const hasContent =
              document.body &&
              (document.body.innerText.length > 100 ||
                document.querySelectorAll("img, canvas, svg, .chart, .graph")
                  .length > 0);

            // Page is ready if no loading indicators AND has content
            return !hasLoading && hasContent;
          },
          {
            timeout: maxWaitTime,
            polling: 500, // Check every 500ms
          }
        );
      } catch (smartLoadError) {
        console.log(
          "Smart loading detection failed, using fallback:",
          smartLoadError.message
        );
        // Fallback: simple timeout
        await page.waitForTimeout(Math.min(maxWaitTime, 5000));
      }

      // Additional wait for dynamic content (charts, tables, etc.)
      try {
        await page.waitForFunction(
          () => {
            // Check for dynamic content that might load after initial page load
            const dynamicSelectors = [
              ".price-chart",
              ".market-data",
              ".crypto-table",
              ".coin-stats",
              ".chart-container",
              ".tradingview-widget",
              ".highcharts-container",
              ".chartjs-render-monitor",
              "canvas",
              ".data-table",
              ".price-display",
            ];

            // Check if we have some dynamic content loaded
            const hasDynamicContent = dynamicSelectors.some((sel) => {
              const el = document.querySelector(sel);
              return el && el.offsetHeight > 0;
            });

            // Also check for meaningful text content
            const hasTextContent =
              document.body && document.body.innerText.length > 200;

            return hasDynamicContent || hasTextContent;
          },
          {
            timeout: 10000, // Wait up to 10 seconds for dynamic content
            polling: 1000, // Check every second
          }
        );
        console.log("Dynamic content loaded successfully");
      } catch (dynamicErr) {
        console.log("Dynamic content wait timed out, proceeding anyway");
      }

      // Handle cookie consent popups (enabled by default)
      const handleCookies = req.query.handleCookies !== "false"; // Default true

      if (handleCookies) {
        try {
          console.log("Checking for cookie consent popups...");

          // Wait a bit for cookie popups to load
          await page.waitForTimeout(2000);

          // Common cookie consent selectors for various sites
          const cookieSelectors = [
            // General cookie buttons
            '[data-testid="cookie-accept"]',
            '[data-testid="accept-cookies"]',
            ".cookie-accept",
            ".accept-cookies",
            ".gdpr-accept",
            ".consent-accept",
            "#accept-cookies",
            ".cookie-consent-accept",

            // FlashScore specific
            ".cookie-alert-accept",
            ".cookie-banner-accept",
            '.cookie-consent button[data-type="accept"]',

            // Google/Looker Studio specific
            ".cookie-consent-accept",
            ".cookie-consent button",

            // CoinMarketCap specific
            ".cookie-acceptance-button",
            ".cookie-banner-accept",
            ".gdpr-cookie-accept",
            ".cookie-policy-accept",
            ".accept-all-cookies",

            // Aria labels
            '[aria-label*="accept" i]',
            '[aria-label*="agree" i]',
            '[aria-label*="ok" i]',
          ];

          // Try to click cookie accept buttons with retry
          let cookieClicked = false;
          for (let attempt = 0; attempt < 3 && !cookieClicked; attempt++) {
            if (attempt > 0) {
              console.log(`Cookie attempt ${attempt + 1}/3...`);
              await page.waitForTimeout(1000);
            }

            for (const selector of cookieSelectors) {
              try {
                const button = await page.$(selector);
                if (button) {
                  const isVisible = await page.evaluate((el) => {
                    const rect = el.getBoundingClientRect();
                    return (
                      rect.width > 0 &&
                      rect.height > 0 &&
                      window.getComputedStyle(el).visibility !== "hidden"
                    );
                  }, button);

                  if (isVisible) {
                    await button.click();
                    console.log(`Clicked cookie accept button: ${selector}`);
                    cookieClicked = true;
                    await page.waitForTimeout(1000); // Wait for popup to close
                    break;
                  }
                }
              } catch (clickErr) {
                // Continue to next selector
                continue;
              }
            }
          }

          // Try text-based button search for buttons that don't have good selectors
          if (!cookieClicked) {
            const textSelectors = [
              "Accept",
              "Accept All",
              "I Accept",
              "OK",
              "Agree",
              "I agree",
              "Accept Cookies",
              "Allow All",
            ];
            for (const text of textSelectors) {
              try {
                const button = await page.evaluateHandle((searchText) => {
                  const buttons = Array.from(
                    document.querySelectorAll(
                      'button, [role="button"], input[type="button"], input[type="submit"], a'
                    )
                  );
                  return buttons.find((btn) => {
                    const textContent =
                      btn.textContent || btn.innerText || btn.value || "";
                    return (
                      textContent
                        .toLowerCase()
                        .includes(searchText.toLowerCase()) &&
                      btn.offsetWidth > 0 &&
                      btn.offsetHeight > 0 &&
                      window.getComputedStyle(btn).visibility !== "hidden"
                    );
                  });
                }, text);

                if (button && !button.isEmpty()) {
                  await button.click();
                  console.log(
                    `Clicked text-based cookie accept button: "${text}"`
                  );
                  cookieClicked = true;
                  await page.waitForTimeout(1000);
                  break;
                }
              } catch (clickErr) {
                continue;
              }
            }
          }

          // Alternative: try to remove cookie banners entirely
          await page.evaluate(() => {
            const cookieElements = [
              ".cookie-banner",
              ".cookie-consent",
              ".gdpr-banner",
              ".cookie-alert",
              ".cookie-popup",
              '[data-testid*="cookie"]',
              ".fc-consent-root", // Foundry CMP
              "#cookie-consent", // Google specific
              ".cookie-consent-popup",
              ".consent-modal",
              ".gdpr-consent",
              // CoinMarketCap specific
              ".cookie-acceptance",
              ".cookie-policy-banner",
              ".gdpr-banner",
            ];

            cookieElements.forEach((selector) => {
              const elements = document.querySelectorAll(selector);
              elements.forEach((el) => {
                if (el && el.parentNode) {
                  el.parentNode.removeChild(el);
                  console.log(`Removed cookie element: ${selector}`);
                }
              });
            });

            // Also try to hide elements with inline styles
            const allElements = document.querySelectorAll("*");
            allElements.forEach((el) => {
              const text = (el.textContent || "").toLowerCase();
              if (
                (text.includes("cookie") &&
                  (text.includes("accept") || text.includes("agree"))) ||
                text.includes("gdpr") ||
                text.includes("consent")
              ) {
                if (el.offsetHeight > 0) {
                  el.style.display = "none";
                  console.log("Hidden cookie-related element");
                }
              }
            });
          });

          console.log("Cookie handling completed");
        } catch (cookieErr) {
          console.log("Cookie handling failed:", cookieErr.message);
          // Continue with screenshot anyway
        }
      }
    } catch (err) {
      console.log(
        "Smart loading detection timed out, proceeding with screenshot:",
        err.message
      );
      // Continue anyway - better to take screenshot than fail completely
    }

    const screenshotType = req.query.type || "png";
    const screenshotOptions = {
      fullPage: req.query.fullPage !== "false",
      type: screenshotType,
    };

    // Only add quality for JPEG
    if (screenshotType === "jpeg" || screenshotType === "jpg") {
      screenshotOptions.quality = parseInt(req.query.quality) || 90;
    }

    const buffer = await page.screenshot(screenshotOptions);

    const contentType =
      screenshotType === "jpeg" || screenshotType === "jpg"
        ? "image/jpeg"
        : "image/png";
    res.set("Content-Type", contentType);
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
      res.status(503).json({
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
      "GET /screenshot?url=<URL>&width=<WIDTH>&height=<HEIGHT>&fullPage=<true/false>&wait=<MS>&type=<png/jpeg>&quality=<1-100>&handleCookies=<true/false>",
      "GET /health",
      "GET /status",
    ],
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Screenshot API is running",
    usage: "GET /screenshot?url=https://example.com&wait=5000",
    examples: {
      basic: "/screenshot?url=https://example.com",
      dashboard: "/screenshot?url=https://dashboard.com&wait=10000&type=jpeg",
      custom:
        "/screenshot?url=https://site.com&width=1920&height=1080&wait=3000",
    },
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
