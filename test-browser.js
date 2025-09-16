const puppeteer = require("puppeteer");
const puppeteerCore = require("puppeteer-core");
const fs = require("fs");

// Browser creation function with enhanced fallback logic (extracted from main app)
async function createBrowser(retryCount = 0) {
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
        // Common Chromium paths on Linux/Render
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
          const puppeteerCacheDir =
            process.env.PUPPETEER_CACHE_DIR ||
            (process.env.RENDER
              ? "/opt/render/.cache/puppeteer"
              : `${process.env.HOME}/.cache/puppeteer`);

          console.log(`Checking Puppeteer cache at: ${puppeteerCacheDir}`);

          // Try multiple possible version patterns
          const possibleVersions = [
            "linux-140.0.7339.82",
            "linux-131.0.6778.85", // Previous version
            "linux-130.0.6723.69", // Older version
          ];

          for (const version of possibleVersions) {
            const bundledPath = `${puppeteerCacheDir}/chrome/${version}/chrome-linux64/chrome`;
            console.log(`Checking: ${bundledPath}`);
            if (fs.existsSync(bundledPath)) {
              executablePath = bundledPath;
              console.log(
                `Found Puppeteer's bundled Chromium: ${executablePath}`
              );
              break;
            }
          }

          // If still not found, try to find any chrome binary in the cache
          if (!executablePath) {
            try {
              const find = require("child_process").execSync;
              const result = find(
                `find ${puppeteerCacheDir} -name "chrome" -type f 2>/dev/null | head -1`,
                { encoding: "utf8" }
              );
              if (result.trim()) {
                executablePath = result.trim();
                console.log(`Found Chrome binary via find: ${executablePath}`);
              }
            } catch (error) {
              console.log("Could not find Chrome binary using find command");
            }
          }
        }
      }

      // If no system browser found, try to use Puppeteer's bundled Chromium
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
          ];
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
        console.log("Attempting fallback with puppeteer-core...");

        // For puppeteer-core, we need an executable path
        if (!executablePath) {
          // Try to find system chromium for puppeteer-core
          const systemPaths = [
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
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

          if (!executablePath) {
            throw new Error("No Chromium executable found for puppeteer-core");
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
      return createBrowser(retryCount + 1);
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

// Test script to validate browser creation with fallback logic
async function testBrowserCreation() {
  console.log("🧪 Testing browser creation with enhanced fallback logic...\n");

  try {
    console.log("1. Testing browser creation...");
    const browser = await createBrowser();
    console.log("✅ Browser created successfully");

    console.log("2. Testing page creation...");
    const page = await browser.newPage();
    console.log("✅ Page created successfully");

    console.log("3. Testing basic navigation...");
    await page.goto("https://httpbin.org/html", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const title = await page.title();
    console.log(`✅ Navigation successful - Page title: "${title}"`);

    console.log("4. Testing screenshot capability...");
    const screenshot = await page.screenshot({ type: "png" });
    console.log(
      `✅ Screenshot taken successfully - Size: ${screenshot.length} bytes`
    );

    console.log("5. Cleaning up...");
    await page.close();
    await browser.close();
    console.log("✅ Cleanup completed");

    console.log(
      "\n🎉 All tests passed! Browser creation with fallback logic is working correctly."
    );
    console.log(
      "💡 The API should now handle Chromium installation failures gracefully."
    );
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error("🔍 Error details:", error);

    // Provide troubleshooting suggestions
    console.log("\n🔧 Troubleshooting suggestions:");
    console.log("1. Check if Chromium is installed: which chromium-browser");
    console.log("2. Check Puppeteer cache: ls -la $PUPPETEER_CACHE_DIR");
    console.log(
      "3. Try manual installation: npx puppeteer browsers install chrome"
    );
    console.log(
      "4. Check system dependencies: apt-get install -y chromium-browser"
    );

    process.exit(1);
  }
}

// Run the test
testBrowserCreation().catch((error) => {
  console.error("💥 Unexpected error during testing:", error);
  process.exit(1);
});
