const express = require("express");
const puppeteer = require("puppeteer");
const crypto = require("crypto");

const app = express();

// Configuration with environment variable support
const CONFIG = {
  IDLE_TIMEOUT: process.env.IDLE_TIMEOUT
    ? parseInt(process.env.IDLE_TIMEOUT)
    : 5 * 60 * 1000, // 5 minutes
  BROWSER_POOL_SIZE: process.env.BROWSER_POOL_SIZE
    ? parseInt(process.env.BROWSER_POOL_SIZE)
    : process.env.RENDER
    ? 1
    : 3, // Smaller pool for Render
  MAX_CONCURRENT_REQUESTS: process.env.MAX_CONCURRENT_REQUESTS
    ? parseInt(process.env.MAX_CONCURRENT_REQUESTS)
    : process.env.RENDER
    ? 2
    : 5, // Fewer concurrent requests for Render
  PAGE_LOAD_TIMEOUT: process.env.PAGE_LOAD_TIMEOUT
    ? parseInt(process.env.PAGE_LOAD_TIMEOUT)
    : 60000, // 60 seconds
  CONTENT_STABILITY_TIMEOUT: process.env.CONTENT_STABILITY_TIMEOUT
    ? parseInt(process.env.CONTENT_STABILITY_TIMEOUT)
    : 15000, // 15 seconds for content stability check
  CRITICAL_CONTENT_TIMEOUT: process.env.CRITICAL_CONTENT_TIMEOUT
    ? parseInt(process.env.CRITICAL_CONTENT_TIMEOUT)
    : 20000, // 20 seconds for critical content wait
  CACHE_TTL: process.env.CACHE_TTL
    ? parseInt(process.env.CACHE_TTL)
    : 10 * 60 * 1000, // 10 minutes
  MEMORY_THRESHOLD: process.env.MEMORY_THRESHOLD
    ? parseInt(process.env.MEMORY_THRESHOLD)
    : 512 * 1024 * 1024, // 512MB
};

// Browser pool management
class BrowserPool {
  constructor(poolSize = CONFIG.BROWSER_POOL_SIZE) {
    this.poolSize = poolSize;
    this.browsers = [];
    this.availableBrowsers = [];
    this.waitingQueue = [];
    this.isShuttingDown = false;
  }

  async initialize() {
    console.log(`Initializing browser pool with ${this.poolSize} instances...`);
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const browser = await this.createBrowser();
        this.browsers.push(browser);
        this.availableBrowsers.push(browser);
        console.log(`Browser ${i + 1}/${this.poolSize} initialized`);
      } catch (error) {
        console.error(`Failed to initialize browser ${i + 1}:`, error.message);
      }
    }
    console.log(
      `Browser pool initialized with ${this.availableBrowsers.length} browsers`
    );
  }

  async createBrowser(retryCount = 0) {
    const maxRetries = 3;
    const baseDelay = 2000; // 2 seconds

    try {
      console.log(
        `Creating browser instance (attempt ${retryCount + 1}/${
          maxRetries + 1
        })...`
      );

      const launchOptions = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--disable-ipc-flooding-protection",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
          "--disable-hang-monitor",
          "--disable-prompt-on-repost",
          "--force-color-profile=srgb",
          "--no-first-run",
          "--enable-automation",
          "--disable-sync",
          "--disable-translate",
          "--hide-scrollbars",
          "--mute-audio",
          "--disable-logging",
          "--disable-dev-tools",
          "--disable-extensions",
          "--disable-component-extensions-with-background-pages",
          "--disable-background-networking",
          "--disable-default-apps",
          "--metrics-recording-only",
          "--mute-audio",
          "--no-first-run",
          "--safebrowsing-disable-auto-update",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--max_old_space_size=512", // Limit memory usage
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        ignoreHTTPSErrors: true,
        timeout: process.env.RENDER ? 120000 : 60000, // 2 minutes for Render, 1 minute for others
      };

      // Browser executable detection with improved Render support
      let executablePath = null;
      const fs = require("fs");
      const path = require("path");

      // For Windows - try Microsoft Edge first, then Chrome
      if (process.platform === "win32") {
        const edgePaths = [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ];

        for (const edgePath of edgePaths) {
          if (fs.existsSync(edgePath)) {
            executablePath = edgePath;
            console.log(`Found Edge browser at: ${executablePath}`);
            break;
          }
        }

        if (!executablePath) {
          const chromePaths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            process.env.PUPPETEER_EXECUTABLE_PATH,
          ].filter(Boolean);

          for (const chromePath of chromePaths) {
            if (fs.existsSync(chromePath)) {
              executablePath = chromePath;
              console.log(`Found Chrome browser at: ${executablePath}`);
              break;
            }
          }
        }
      }

      // For Render deployment and other Linux environments
      if (
        !executablePath &&
        (process.env.RENDER || process.platform === "linux")
      ) {
        console.log("Detecting browser for Linux/Render environment...");

        // Check environment variable first
        if (
          process.env.PUPPETEER_EXECUTABLE_PATH &&
          fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
        ) {
          executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
          console.log(`Using PUPPETEER_EXECUTABLE_PATH: ${executablePath}`);
        } else {
          // Extended list of Chromium paths for Render and Linux
          const chromiumPaths = [
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/lib/bin/chromium-browser",
            "/usr/lib/bin/chromium",
            "/opt/google/chrome/chrome",
            "/opt/chromium/chromium",
            "/snap/bin/chromium",
            "/snap/bin/chromium-browser",
            "/usr/local/bin/chromium-browser",
            "/usr/local/bin/chromium",
            "/usr/local/bin/google-chrome-stable",
            "/usr/local/bin/google-chrome",
            // Additional paths that might exist on Render
            "/app/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome",
            "/app/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome",
            "/app/.cache/puppeteer/chrome/linux-130.0.6723.69/chrome-linux64/chrome",
            "/tmp/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome",
            "/tmp/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome",
            "/tmp/.cache/puppeteer/chrome/linux-130.0.6723.69/chrome-linux64/chrome",
          ];

          for (const chromiumPath of chromiumPaths) {
            if (fs.existsSync(chromiumPath)) {
              executablePath = chromiumPath;
              console.log(`Found Chromium at: ${executablePath}`);
              break;
            }
          }

          // If still not found, try multiple version patterns in cache
          if (!executablePath) {
            const puppeteerCacheDirs = [
              process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer",
              "/app/.cache/puppeteer",
              "/tmp/.cache/puppeteer",
              `${process.env.HOME}/.cache/puppeteer`,
              "/root/.cache/puppeteer",
            ];

            for (const cacheDir of puppeteerCacheDirs) {
              console.log(`Checking Puppeteer cache at: ${cacheDir}`);

              // Try multiple possible version patterns
              const possibleVersions = [
                "linux-140.0.7339.82",
                "linux-131.0.6778.85",
                "linux-130.0.6723.69",
                "linux-129.0.6668.89",
                "linux-128.0.6613.84",
              ];

              for (const version of possibleVersions) {
                const bundledPath = `${cacheDir}/chrome/${version}/chrome-linux64/chrome`;
                console.log(`Checking: ${bundledPath}`);
                if (fs.existsSync(bundledPath)) {
                  executablePath = bundledPath;
                  console.log(
                    `Found Puppeteer's bundled Chromium: ${executablePath}`
                  );
                  break;
                }
              }

              if (executablePath) break;

              // If still not found, try to find any chrome binary in the cache
              try {
                const find = require("child_process").execSync;
                const result = find(
                  `find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`,
                  { encoding: "utf8" }
                );
                if (result.trim()) {
                  executablePath = result.trim();
                  console.log(
                    `Found Chrome binary via find: ${executablePath}`
                  );
                  break;
                }
              } catch (error) {
                console.log(
                  `Could not find Chrome binary using find command in ${cacheDir}`
                );
              }
            }
          }

          // Last resort: Search entire filesystem for any chromium-like browser
          if (!executablePath) {
            console.log(
              "Searching entire filesystem for any chromium-like browser..."
            );
            try {
              const find = require("child_process").execSync;
              // Search for common browser names
              const browserNames = [
                "chromium",
                "chromium-browser",
                "google-chrome",
                "google-chrome-stable",
                "chrome",
              ];
              for (const browserName of browserNames) {
                try {
                  const result = find(
                    `find /usr /opt /snap /app -name "${browserName}" -type f -executable 2>/dev/null | head -1`,
                    { encoding: "utf8" }
                  );
                  if (result.trim()) {
                    executablePath = result.trim();
                    console.log(
                      `Found browser via filesystem search: ${executablePath}`
                    );
                    break;
                  }
                } catch (e) {
                  // Continue to next browser name
                }
              }

              // If still not found, try a broader search
              if (!executablePath) {
                try {
                  const result = require("child_process").execSync(
                    `find /usr /opt /snap /app -name "*chrom*" -type f -executable 2>/dev/null | head -1`,
                    { encoding: "utf8" }
                  );
                  if (result.trim()) {
                    executablePath = result.trim();
                    console.log(
                      `Found chromium-like binary via broad search: ${executablePath}`
                    );
                  }
                } catch (e) {
                  console.log("Broad chromium search also failed");
                }
              }
            } catch (error) {
              console.log("Filesystem search failed:", error.message);
            }
          }
        }
        if (!executablePath) {
          try {
            console.log(
              "No system browser found, attempting to use Puppeteer's bundled Chromium..."
            );
            console.log("Will attempt to download Chromium during launch...");
            console.log(
              "If this fails, run: npx puppeteer browsers install chrome"
            );

            // Set additional launch args to help with auto-download
            launchOptions.args = [
              ...launchOptions.args,
              "--single-process",
              "--no-zygote",
              "--disable-dev-tools",
              "--disable-background-timer-throttling",
              "--disable-renderer-backgrounding",
              "--disable-features=TranslateUI,BlinkGenPropertyTrees",
              "--disable-ipc-flooding-protection",
              "--disable-hang-monitor",
              "--disable-prompt-on-repost",
              "--force-color-profile=srgb",
              "--metrics-recording-only",
              "--no-first-run",
              "--enable-automation",
              "--password-store=basic",
              "--use-mock-keychain",
              "--no-service-autorun",
              "--export-tagged-pdf",
              "--disable-search-engine-choice-screen",
              "--disable-component-update",
              "--disable-domain-reliability",
              "--disable-client-side-phishing-detection",
              "--disable-background-networking",
              "--no-default-browser-check",
              "--no-pings",
              "--disable-web-security",
              "--allow-running-insecure-content",
            ];

            // Try to trigger download by setting executablePath to null and letting Puppeteer handle it
            launchOptions.executablePath = undefined;

            // Add download-specific args
            launchOptions.args.push(
              "--disable-features=VizDisplayCompositor,VizHitTestSurfaceLayer"
            );
          } catch (error) {
            console.error(
              "Failed to setup Puppeteer bundled Chromium:",
              error.message
            );
          }
        }
      }

      if (executablePath) {
        launchOptions.executablePath = executablePath;
        console.log(`Using browser executable: ${executablePath}`);
      } else {
        console.log(
          "No specific browser executable found, using Puppeteer's default (bundled Chromium)"
        );
        // Configure Puppeteer to download Chromium if not found
        launchOptions.args = [
          ...launchOptions.args,
          "--disable-dev-tools",
          "--disable-software-rasterizer",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-features=TranslateUI,BlinkGenPropertyTrees",
          "--disable-ipc-flooding-protection",
          "--disable-hang-monitor",
          "--disable-prompt-on-repost",
          "--force-color-profile=srgb",
          "--metrics-recording-only",
          "--no-first-run",
          "--enable-automation",
          "--password-store=basic",
          "--use-mock-keychain",
          "--no-service-autorun",
          "--export-tagged-pdf",
          "--disable-search-engine-choice-screen",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--disable-client-side-phishing-detection",
          "--disable-background-networking",
          "--no-default-browser-check",
          "--no-pings",
          "--disable-web-security",
          "--allow-running-insecure-content",
        ];
      }

      // Try regular puppeteer first
      try {
        const puppeteer = require("puppeteer");
        const browser = await puppeteer.launch(launchOptions);
        console.log(
          `Browser created successfully with puppeteer on attempt ${
            retryCount + 1
          }`
        );
        return browser;
      } catch (puppeteerError) {
        console.log(`Puppeteer launch failed: ${puppeteerError.message}`);

        // Try puppeteer-core as fallback
        try {
          const puppeteerCore = require("puppeteer-core");
          console.log("Attempting fallback with puppeteer-core...");

          // For puppeteer-core, we need an executable path
          if (!executablePath) {
            // Try to find system chromium for puppeteer-core
            const systemPaths = [
              "/usr/bin/chromium-browser",
              "/usr/bin/chromium",
              "/usr/bin/google-chrome-stable",
              "/usr/bin/google-chrome",
              "/usr/lib/bin/chromium-browser",
              "/usr/lib/bin/chromium",
              "/usr/local/bin/chromium-browser",
              "/usr/local/bin/chromium",
              "/usr/local/bin/google-chrome-stable",
              "/usr/local/bin/google-chrome",
              "/opt/google/chrome/chrome",
              "/opt/chromium/chromium",
              "/snap/bin/chromium",
              "/snap/bin/chromium-browser",
            ];

            for (const sysPath of systemPaths) {
              if (fs.existsSync(sysPath)) {
                executablePath = sysPath;
                console.log(
                  `Found system Chromium for puppeteer-core: ${executablePath}`
                );
                break;
              }
            }

            // If still no executable found, try to find any chromium-like binary
            if (!executablePath) {
              try {
                const find = require("child_process").execSync;
                const result = find(
                  `find /usr -name "*chrom*" -type f -executable 2>/dev/null | head -1`,
                  { encoding: "utf8" }
                );
                if (result.trim()) {
                  executablePath = result.trim();
                  console.log(`Found Chromium-like binary: ${executablePath}`);
                }
              } catch (error) {
                console.log("Could not find any Chromium-like binary");
              }
            }

            if (!executablePath) {
              throw new Error(
                "No Chromium executable found for puppeteer-core"
              );
            }
          }

          launchOptions.executablePath = executablePath;
          const browser = await puppeteerCore.launch(launchOptions);
          console.log(
            `Browser created successfully with puppeteer-core on attempt ${
              retryCount + 1
            }`
          );
          return browser;
        } catch (coreError) {
          console.log(
            `Puppeteer-core fallback also failed: ${coreError.message}`
          );
          throw puppeteerError; // Throw original error
        }
      }
    } catch (error) {
      console.error(
        `Browser creation failed on attempt ${retryCount + 1}:`,
        error.message
      );

      if (retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
        console.log(`Retrying browser creation in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.createBrowser(retryCount + 1);
      } else {
        console.error(
          `Failed to create browser after ${maxRetries + 1} attempts`
        );
        throw new Error(
          `Browser creation failed after ${maxRetries + 1} attempts: ${
            error.message
          }`
        );
      }
    }
  }

  async acquireBrowser(retryCount = 0) {
    if (this.isShuttingDown) {
      throw new Error("Browser pool is shutting down");
    }

    const maxRetries = 2;

    try {
      // Return available browser immediately
      if (this.availableBrowsers.length > 0) {
        const browser = this.availableBrowsers.pop();
        if (this.isBrowserHealthy(browser)) {
          console.log("Acquired healthy browser from pool");
          return browser;
        } else {
          // Browser is unhealthy, remove it and try again
          console.log("Removing unhealthy browser from pool");
          this.removeBrowser(browser);
          return this.acquireBrowser(retryCount);
        }
      }

      // If no browsers available and pool not full, create new one
      if (this.browsers.length < this.poolSize) {
        try {
          console.log(
            `Creating new browser (${this.browsers.length + 1}/${
              this.poolSize
            })`
          );
          const browser = await this.createBrowser();
          this.browsers.push(browser);
          console.log("Browser created and added to pool successfully");
          return browser;
        } catch (error) {
          console.error(
            `Failed to create new browser (attempt ${retryCount + 1}):`,
            error.message
          );

          if (retryCount < maxRetries) {
            console.log(`Retrying browser creation in 3 seconds...`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            return this.acquireBrowser(retryCount + 1);
          } else {
            console.error(
              `Failed to create browser after ${maxRetries + 1} attempts`
            );
            throw new Error(
              `Browser creation failed after ${maxRetries + 1} attempts: ${
                error.message
              }`
            );
          }
        }
      }

      // Wait for available browser with increased timeout
      console.log("No available browsers, waiting in queue...");
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = this.waitingQueue.indexOf(resolve);
          if (index > -1) {
            this.waitingQueue.splice(index, 1);
          }
          console.error("Browser acquisition timeout after 60 seconds");
          reject(
            new Error(
              "Browser acquisition timeout - no browser available within 60 seconds"
            )
          );
        }, 60000); // Increased from 30 to 60 seconds

        this.waitingQueue.push((browser) => {
          clearTimeout(timeout);
          console.log("Browser acquired from queue");
          resolve(browser);
        });
      });
    } catch (error) {
      if (retryCount < maxRetries && !error.message.includes("shutting down")) {
        console.log(
          `Retrying browser acquisition in 2 seconds... (${retryCount + 1}/${
            maxRetries + 1
          })`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return this.acquireBrowser(retryCount + 1);
      }
      throw error;
    }
  }

  releaseBrowser(browser) {
    if (this.isShuttingDown) {
      this.removeBrowser(browser);
      return;
    }

    if (this.isBrowserHealthy(browser)) {
      // Notify waiting requests
      if (this.waitingQueue.length > 0) {
        const resolve = this.waitingQueue.shift();
        resolve(browser);
      } else {
        this.availableBrowsers.push(browser);
      }
    } else {
      this.removeBrowser(browser);
    }
  }

  isBrowserHealthy(browser) {
    try {
      return browser && !browser.isConnected() === false;
    } catch (error) {
      return false;
    }
  }

  removeBrowser(browser) {
    const index = this.browsers.indexOf(browser);
    if (index > -1) {
      this.browsers.splice(index, 1);
    }

    const availIndex = this.availableBrowsers.indexOf(browser);
    if (availIndex > -1) {
      this.availableBrowsers.splice(availIndex, 1);
    }

    try {
      if (browser && browser.isConnected()) {
        // Close browser with timeout to prevent hanging
        const closePromise = browser.close();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Browser close timeout")), 5000)
        );

        Promise.race([closePromise, timeoutPromise]).catch((error) => {
          console.log("Browser close warning:", error.message);
          // Don't throw - we want to continue cleanup
        });
      }
    } catch (error) {
      console.error("Error closing browser:", error.message);
    }
  }

  async shutdown() {
    console.log("Shutting down browser pool...");
    this.isShuttingDown = true;

    // Reject all waiting requests
    this.waitingQueue.forEach((resolve) => {
      resolve(Promise.reject(new Error("Browser pool is shutting down")));
    });
    this.waitingQueue = [];

    // Close all browsers with better error handling
    const closePromises = this.browsers.map(async (browser) => {
      try {
        if (browser && browser.isConnected()) {
          // Close browser with timeout to prevent hanging
          const closePromise = browser.close();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Browser close timeout")), 10000)
          );

          await Promise.race([closePromise, timeoutPromise]).catch((error) => {
            console.log(
              "Browser close warning during shutdown:",
              error.message
            );
          });
        }
      } catch (error) {
        console.log("Browser close error during shutdown:", error.message);
      }
    });

    await Promise.all(closePromises);
    this.browsers = [];
    this.availableBrowsers = [];
    console.log("Browser pool shutdown complete");
  }

  getStats() {
    return {
      total: this.browsers.length,
      available: this.availableBrowsers.length,
      waiting: this.waitingQueue.length,
      poolSize: this.poolSize,
    };
  }
}

// Request queue for limiting concurrent requests
class RequestQueue {
  constructor(maxConcurrent = CONFIG.MAX_CONCURRENT_REQUESTS) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async addRequest(handler) {
    return new Promise((resolve, reject) => {
      this.queue.push({ handler, resolve, reject });

      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { handler, resolve, reject } = this.queue.shift();

    try {
      const result = await handler();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

// Simple in-memory cache
class SimpleCache {
  constructor(ttl = CONFIG.CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    const expiresAt = Date.now() + this.ttl;
    this.cache.set(key, { value, expiresAt });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  size() {
    // Clean expired items
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
      }
    }
    return this.cache.size;
  }
}

// Memory monitor
class MemoryMonitor {
  constructor(threshold = CONFIG.MEMORY_THRESHOLD) {
    this.threshold = threshold;
    this.lastGC = Date.now();
  }

  shouldGC() {
    const memUsage = process.memoryUsage();
    const shouldGC = memUsage.heapUsed > this.threshold;
    const timeSinceLastGC = Date.now() - this.lastGC;

    // Force GC if memory usage is high and it's been more than 30 seconds
    return shouldGC && timeSinceLastGC > 30000;
  }

  forceGC() {
    if (global.gc) {
      global.gc();
      this.lastGC = Date.now();
      console.log("Forced garbage collection");
    }
  }

  getStats() {
    const memUsage = process.memoryUsage();
    return {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + "MB",
      external: Math.round(memUsage.external / 1024 / 1024) + "MB",
      rss: Math.round(memUsage.rss / 1024 / 1024) + "MB",
    };
  }
}

// Initialize services
const browserPool = new BrowserPool();
const requestQueue = new RequestQueue();
const cache = new SimpleCache();
const memoryMonitor = new MemoryMonitor();

// Global state
let lastActivity = Date.now();
let idleTimeout;

// Initialize services on startup
async function initializeServices() {
  try {
    await browserPool.initialize();
    console.log("All services initialized successfully");
  } catch (error) {
    console.error("Failed to initialize services:", error);
    process.exit(1);
  }
}

// Comprehensive page loading function with dynamic content detection
async function waitForPageLoad(page, timeout = CONFIG.PAGE_LOAD_TIMEOUT) {
  try {
    console.log("Waiting for complete page load...");

    // 1. Wait for DOM to load completely
    console.log("1. Waiting for DOM to load...");
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout: timeout * 0.3, // 30% of total time
    });

    // 2. Wait for main content in the webpage
    console.log("2. Waiting for main content...");
    await page.waitForFunction(
      () => document.body && document.body.innerText.length > 50,
      { timeout: timeout * 0.2 }
    );

    // 3. Handle cookie consent popup
    console.log("3. Handling cookie consent...");
    await dismissCookieConsent(page);

    // 4. Wait for network activity to settle (wait for API calls to complete)
    console.log("4. Waiting for network activity to settle...");
    try {
      await page.waitForLoadState("networkidle", { timeout: timeout * 0.2 });
    } catch (e) {
      console.log("Network not idle but proceeding...");
    }

    // 5. Wait for DOM content to change less (for websites with async data loading)
    console.log("5. Waiting for DOM content to stabilize...");
    await waitForContentStability(page, CONFIG.CONTENT_STABILITY_TIMEOUT);

    // 6. Scroll slowly to trigger lazy loading and dynamic content
    console.log("6. Scrolling to trigger lazy loading...");
    await triggerLazyLoading(page);

    // 7. Wait for all images to load (if any)
    console.log("7. Waiting for images to load...");
    try {
      await page.waitForFunction(
        () => {
          const images = Array.from(document.querySelectorAll("img"));
          return (
            images.length === 0 ||
            images.every((img) => img.complete && img.naturalHeight > 0)
          );
        },
        { timeout: timeout * 0.1 }
      );
    } catch (e) {
      console.log("Some images may not load but proceeding");
    }

    // 8. Wait for iframes to load (for websites with iframes)
    console.log("8. Waiting for iframes to load...");
    try {
      await page.waitForFunction(
        () => {
          const iframes = Array.from(document.querySelectorAll("iframe"));
          return (
            iframes.length === 0 ||
            iframes.every((iframe) => iframe.contentDocument)
          );
        },
        { timeout: timeout * 0.1 }
      );
    } catch (e) {
      console.log("Some iframes may not load but proceeding");
    }

    // 9. Wait for JavaScript and animations to complete
    console.log("9. Waiting for JavaScript and animations to complete...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 10. Check and wait for critical content to load
    console.log("10. Checking for critical content...");
    await waitForCriticalContent(page, CONFIG.CRITICAL_CONTENT_TIMEOUT);

    console.log("✅ Page loaded completely!");
  } catch (error) {
    console.log(
      "⚠️ Page load timeout for some parts but proceeding:",
      error.message
    );
  }
}

// Check content stability
async function waitForContentStability(page, timeout = 10000) {
  try {
    let previousContent = "";
    let stableCount = 0;
    const maxChecks = 8;
    const checkInterval = Math.min(timeout / maxChecks, 1000);

    for (let i = 0; i < maxChecks; i++) {
      const currentContent = await page.evaluate(() => {
        return document.body ? document.body.innerHTML.length : 0;
      });

      if (currentContent === previousContent && currentContent > 0) {
        stableCount++;
        if (stableCount >= 3) {
          console.log("DOM content stabilized");
          break;
        }
      } else {
        stableCount = 0;
      }

      previousContent = currentContent;
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  } catch (error) {
    console.log("Content stability check failed:", error.message);
  }
}

// Trigger lazy loading by scrolling
async function triggerLazyLoading(page) {
  try {
    await page.evaluate(async () => {
      const scrollHeight = document.body.scrollHeight;
      const viewportHeight = window.innerHeight;
      let currentPosition = 0;
      const scrollStep = viewportHeight * 0.8;

      while (currentPosition < scrollHeight - viewportHeight) {
        window.scrollBy(0, scrollStep);
        currentPosition += scrollStep;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }

      // Scroll back to top
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
  } catch (error) {
    console.log("Lazy loading trigger failed:", error.message);
  }
}

// Wait for critical content to load
async function waitForCriticalContent(page, timeout = 10000) {
  try {
    await page.waitForFunction(
      () => {
        // Check important selectors for various websites
        const criticalSelectors = [
          // General content
          "main",
          ".main-content",
          ".content",
          ".container",
          ".wrapper",

          // Dashboard/Report content
          ".dashboard",
          ".report",
          ".chart",
          ".graph",
          ".table",
          ".data-table",

          // E-commerce
          ".product-list",
          ".product-grid",
          ".catalog",

          // News/Content sites
          ".article",
          ".post",
          ".entry",
          ".news-item",

          // Sports sites (FlashScore, etc.)
          ".sportName",
          ".event__match",
          ".event__header",
          ".league",
          ".participant",
          ".odds",
          ".live",
          ".result",

          // Check for meaningful text content
          () => document.body && document.body.innerText.length > 200,
        ];

        // Check if any critical content is present
        for (const selector of criticalSelectors) {
          if (typeof selector === "function") {
            if (selector()) return true;
          } else if (document.querySelector(selector)) {
            const element = document.querySelector(selector);
            if (element && element.offsetHeight > 0) {
              return true;
            }
          }
        }

        return false;
      },
      { timeout }
    );

    console.log("Critical content detected");
  } catch (error) {
    console.log("Critical content check failed:", error.message);
  }
}

// Simplified cookie dismissal
async function dismissCookieConsent(page) {
  try {
    const cookieSelectors = [
      '[data-testid="cookie-accept"]',
      '[data-testid="accept-cookies"]',
      ".cookie-accept",
      ".accept-cookies",
      ".gdpr-accept",
      ".consent-accept",
      "#accept-cookies",
      ".cookie-consent-accept",
      ".fc-consent-root",
      "#cookie-consent",
    ];

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
            await new Promise((resolve) => setTimeout(resolve, 500));
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.log("Cookie handling failed:", error.message);
  }
}

// Schedule browser pool cleanup
function scheduleCleanup() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
  }

  idleTimeout = setTimeout(async () => {
    if (Date.now() - lastActivity >= CONFIG.IDLE_TIMEOUT) {
      console.log(
        `Service idle for ${CONFIG.IDLE_TIMEOUT / 1000} seconds, cleaning up...`
      );
      await browserPool.shutdown();
      cache.clear();
    }
  }, CONFIG.IDLE_TIMEOUT);
}

// Cancel cleanup
function cancelCleanup() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
    idleTimeout = null;
  }
}

// Screenshot endpoint with optimizations
app.get("/screenshot", async (req, res) => {
  const startTime = Date.now();
  lastActivity = startTime;

  // Check memory and force GC if needed
  if (memoryMonitor.shouldGC()) {
    memoryMonitor.forceGC();
  }

  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Generate cache key
  const cacheKey = crypto
    .createHash("md5")
    .update(
      `${url}_${req.query.width || 1920}_${req.query.height || 1080}_${
        req.query.fullPage !== "false"
      }_${req.query.type || "png"}`
    )
    .digest("hex");

  // Check cache first
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    console.log(`Serving cached screenshot for ${url}`);
    res.set("Content-Type", cachedResult.contentType);
    res.set("Cache-Control", "public, max-age=3600");
    res.set("X-Cache", "HIT");
    return res.send(cachedResult.buffer);
  }

  // Add request to queue
  try {
    await requestQueue.addRequest(async () => {
      let browser = null;
      let page = null;

      try {
        // Validate URL
        new URL(url);

        // Acquire browser from pool
        browser = await browserPool.acquireBrowser();

        // Create new page
        page = await browser.newPage();

        // Set viewport
        await page.setViewport({
          width: parseInt(req.query.width) || 1920,
          height: parseInt(req.query.height) || 1080,
          deviceScaleFactor: 1,
        });

        // Set user agent and headers
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,th;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          DNT: "1",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        });

        // Set geolocation for specific sites
        if (url.includes("flashscore.com")) {
          await page.setGeolocation({ latitude: 13.7563, longitude: 100.5018 });
        }

        // Navigate to page with longer timeout
        console.log(`Navigating to ${url}...`);
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: CONFIG.PAGE_LOAD_TIMEOUT,
        });

        if (!response || !response.ok()) {
          throw new Error(
            `Page load failed with status: ${response?.status()}`
          );
        }

        // Wait for comprehensive page load with dynamic content
        await waitForPageLoad(page, CONFIG.PAGE_LOAD_TIMEOUT);

        // Special handling for FlashScore with extended wait
        if (url.includes("flashscore.com")) {
          console.log("Applying FlashScore-specific optimizations...");

          // Wait for FlashScore specific content with longer timeout
          try {
            await page.waitForFunction(
              () => {
                const selectors = [
                  ".sportName", // Sport names
                  ".event__match", // Match events
                  ".event__header", // Event headers
                  ".league", // League names
                  ".participant", // Team/player names
                  ".odds", // Odds data
                  ".live", // Live indicators
                  ".result", // Match results
                  "main", // Main content
                  ".container", // Main container
                  ".menu", // Navigation menu
                  ".header", // Header content
                ];

                // Check if any content is visible
                for (const selector of selectors) {
                  const element = document.querySelector(selector);
                  if (element && element.offsetHeight > 0) {
                    return true;
                  }
                }

                // Check for meaningful text content
                return document.body && document.body.innerText.length > 300;
              },
              { timeout: 20000 } // Extended timeout for FlashScore
            );

            console.log("FlashScore content detected");

            // Additional wait for dynamic content updates
            await new Promise((resolve) => setTimeout(resolve, 3000));

            // Try to scroll to trigger any remaining lazy loading
            await page.evaluate(() => {
              window.scrollTo(0, 500);
              return new Promise((resolve) => setTimeout(resolve, 1500));
            });
          } catch (e) {
            console.log(
              "FlashScore content detection timeout, proceeding anyway"
            );
          }
        }

        // Additional wait for any remaining dynamic content
        console.log("Final wait for any remaining dynamic content...");
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Take screenshot
        const screenshotType = req.query.type || "png";
        const screenshotOptions = {
          fullPage: req.query.fullPage !== "false",
          type: screenshotType,
        };

        if (screenshotType === "jpeg" || screenshotType === "jpg") {
          screenshotOptions.quality = parseInt(req.query.quality) || 90;
        }

        const buffer = await page.screenshot(screenshotOptions);

        // Cache the result
        const contentType =
          screenshotType === "jpeg" || screenshotType === "jpg"
            ? "image/jpeg"
            : "image/png";
        cache.set(cacheKey, { buffer, contentType });

        // Send response
        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=3600");
        res.set("X-Cache", "MISS");
        res.send(buffer);

        const duration = Date.now() - startTime;
        console.log(`Screenshot completed in ${duration}ms for ${url}`);
      } catch (error) {
        console.error(`Screenshot error for ${url}:`, error);

        if (error.code === "ERR_INVALID_URL") {
          res.status(400).json({ error: "Invalid URL provided" });
        } else if (error.name === "TimeoutError") {
          res
            .status(408)
            .json({ error: "Request timeout - page took too long to load" });
        } else {
          res.status(500).json({
            error: "Internal server error while taking screenshot",
            details:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      } finally {
        // Clean up resources
        if (page) {
          try {
            await page.close();
          } catch (error) {
            console.error("Error closing page:", error.message);
          }
        }

        if (browser) {
          browserPool.releaseBrowser(browser);
        }

        // Schedule cleanup
        cancelCleanup();
        scheduleCleanup();
      }
    });
  } catch (error) {
    console.error("Request queue error:", error);
    res.status(503).json({ error: "Service temporarily unavailable" });
  }
});

// Health check endpoint with detailed stats
app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const memoryStats = memoryMonitor.getStats();
  const browserStats = browserPool.getStats();
  const queueStats = requestQueue.getStats();

  const status = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    memory: memoryStats,
    browserPool: browserStats,
    requestQueue: queueStats,
    cache: {
      size: cache.size(),
      ttl: CONFIG.CACHE_TTL,
    },
    lastActivity: new Date(lastActivity).toISOString(),
  };
  res.json(status);
});

// Test page loading endpoint
app.get("/test-loading", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    // Validate URL
    new URL(url);

    // Acquire browser from pool
    const browser = await browserPool.acquireBrowser();
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    });

    // Navigate and test loading
    console.log(`Testing page loading for ${url}...`);
    const startTime = Date.now();

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.PAGE_LOAD_TIMEOUT,
    });

    if (!response || !response.ok()) {
      throw new Error(`Page load failed with status: ${response?.status()}`);
    }

    // Test comprehensive loading
    await waitForPageLoad(page, CONFIG.PAGE_LOAD_TIMEOUT);

    const loadTime = Date.now() - startTime;

    // Get page stats
    const stats = await page.evaluate(() => {
      return {
        title: document.title,
        contentLength: document.body ? document.body.innerText.length : 0,
        imagesCount: document.querySelectorAll("img").length,
        linksCount: document.querySelectorAll("a").length,
        scriptsCount: document.querySelectorAll("script").length,
        domElements: document.querySelectorAll("*").length,
        readyState: document.readyState,
      };
    });

    // Clean up
    await page.close();
    browserPool.releaseBrowser(browser);

    res.json({
      success: true,
      url: url,
      loadTime: `${loadTime}ms`,
      stats: stats,
      message: "Page loaded successfully with comprehensive waiting",
    });
  } catch (error) {
    console.error(`Test loading error for ${url}:`, error);
    res.status(500).json({
      success: false,
      url: url,
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "Optimized Screenshot API is running",
    version: "2.1.0",
    usage: "GET /screenshot?url=https://example.com",
    features: [
      "Browser pooling for better performance",
      "Request queuing to prevent overload",
      "Intelligent caching",
      "Memory management and cleanup",
      "Graceful shutdown handling",
      "Comprehensive page loading with dynamic content detection",
    ],
    examples: {
      basic: "/screenshot?url=https://example.com",
      dashboard: "/screenshot?url=https://dashboard.com&type=jpeg",
      custom: "/screenshot?url=https://site.com&width=1920&height=1080",
      test: "/test-loading?url=https://example.com",
    },
    endpoints: {
      screenshot:
        "/screenshot?url=<URL>&width=<WIDTH>&height=<HEIGHT>&fullPage=<true/false>&type=<png/jpeg>&quality=<1-100>",
      testLoading:
        "/test-loading?url=<URL> (test page loading without taking screenshot)",
      health: "/health",
      status: "/status",
    },
    health: "/health",
    status: "/status",
  });
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, starting graceful shutdown...`);

  cancelCleanup();

  try {
    await browserPool.shutdown();
    cache.clear();

    console.log("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);

  // Don't shutdown for common Puppeteer cleanup errors
  if (
    reason &&
    reason.code === "EBUSY" &&
    reason.message &&
    reason.message.includes("lockfile")
  ) {
    console.log(
      "Ignoring EBUSY lockfile error - this is normal during browser cleanup"
    );
    return;
  }

  gracefulShutdown("unhandledRejection");
});

// Start server
const PORT = process.env.PORT || 3000;

// Initialize services before starting server
initializeServices().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Optimized Screenshot API listening on port ${PORT}`);
    console.log(`🏥 Health check available at http://localhost:${PORT}/health`);
    console.log(`🔧 Configuration:`);
    console.log(`   - Browser pool size: ${CONFIG.BROWSER_POOL_SIZE}`);
    console.log(
      `   - Max concurrent requests: ${CONFIG.MAX_CONCURRENT_REQUESTS}`
    );
    console.log(`   - Page load timeout: ${CONFIG.PAGE_LOAD_TIMEOUT / 1000}s`);
    console.log(
      `   - Content stability timeout: ${
        CONFIG.CONTENT_STABILITY_TIMEOUT / 1000
      }s`
    );
    console.log(
      `   - Critical content timeout: ${
        CONFIG.CRITICAL_CONTENT_TIMEOUT / 1000
      }s`
    );
    console.log(`   - Cache TTL: ${CONFIG.CACHE_TTL / 1000}s`);
    console.log(
      `💡 Tips: Adjust timeouts using environment variables for slow-loading sites`
    );
  });

  // Schedule initial cleanup
  scheduleCleanup();
});
