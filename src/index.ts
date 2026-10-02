/* =========================================================
   WEB AGENT MCP — v0.3.0
   Multi-agent browser automation with human-like behavior,
   CAPTCHA solving, identity vault, and agent messaging.
========================================================= */

import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createServer } from "node:http";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { chromium, BrowserContext, Page } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

chromium.use(StealthPlugin());

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);
const CAPTCHA_KEY = process.env.CAPTCHA_API_KEY || "";
const CAPTCHA_ENABLED = Boolean(CAPTCHA_KEY);
const PROFILES_DIR = path.resolve(process.env.PROFILES_DIR || "./profiles");
const VAULT_DIR = path.resolve(process.env.VAULT_DIR || "./vault");

const server = new McpServer({
  name: "web-agent",
  version: "0.3.0",
});



/* =========================================================
   ZOD 3 -> JSON SCHEMA WRAPPER (Fixes Antigravity tools/list)
========================================================= */
const _origRegisterTool = server.registerTool.bind(server);
(server as any).registerTool = (name: string, config: any, handler: any) => {
  const rawSchema = config?.inputSchema;
  
  // Ensure we have a Zod object schema
  const zodObj = rawSchema instanceof z.ZodType 
    ? rawSchema 
    : z.object(rawSchema || {});

  // Convert Zod 3 schema to standard JSON Schema Draft-07
  const jsonSchema = zodToJsonSchema(zodObj, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as any;

  // Clean top-level schema metadata for MCP compatibility
  delete jsonSchema.$schema;

  // Wrap with MCP SDK's native fromJsonSchema helper
  config = {
    ...config,
    inputSchema: fromJsonSchema(jsonSchema),
  };

  return _origRegisterTool(name, config, handler);
};


/* =========================================================
   HUMANIZE — mouse / typing / scroll
========================================================= */

function rnd(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

async function humanMoveTo(page: Page, x: number, y: number) {
  const start = (page as any).__mousePos ?? {
    x: rnd(100, 300),
    y: rnd(100, 300),
  };
  const end = { x, y };

  const cx1 = start.x + (end.x - start.x) * rnd(0.2, 0.4) + rnd(-50, 50);
  const cy1 = start.y + (end.y - start.y) * rnd(0.2, 0.4) + rnd(-50, 50);
  const cx2 = start.x + (end.x - start.x) * rnd(0.6, 0.8) + rnd(-50, 50);
  const cy2 = start.y + (end.y - start.y) * rnd(0.6, 0.8) + rnd(-50, 50);

  const steps = Math.floor(rnd(15, 30));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = bezier(start.x, cx1, cx2, end.x, t);
    const py = bezier(start.y, cy1, cy2, end.y, t);
    await page.mouse.move(px, py);
    await page.waitForTimeout(rnd(3, 18));
  }
  (page as any).__mousePos = end;
}

async function humanClickLocator(page: Page, locator: any) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element not visible / no bounding box");

  const targetX = box.x + box.width * rnd(0.35, 0.65);
  const targetY = box.y + box.height * rnd(0.35, 0.65);

  await humanMoveTo(page, targetX, targetY);
  await page.waitForTimeout(rnd(60, 180));
  await page.mouse.down();
  await page.waitForTimeout(rnd(40, 120));
  await page.mouse.up();
}

async function humanType(page: Page, selector: string, text: string) {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(page, locator);
  await page.waitForTimeout(rnd(150, 400));

  // clear
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});

  for (const char of text) {
    await page.keyboard.type(char);
    const r = Math.random();
    const delay =
      r < 0.05 ? rnd(400, 800) : r < 0.2 ? rnd(120, 250) : rnd(40, 120);
    await page.waitForTimeout(delay);
  }
}

async function humanScroll(page: Page, amount: number) {
  const dir = amount > 0 ? 1 : -1;
  const total = Math.abs(amount);
  const chunk = 80;
  const steps = Math.ceil(total / chunk);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, chunk * dir);
    await page.waitForTimeout(rnd(20, 80));
  }
}

/* =========================================================
   STEALTH INIT SCRIPT
========================================================= */

const stealthInitScript = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "plugins", {
    get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
  });
  Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en"],
  });

  try {
    const getParameter = (WebGLRenderingContext as any).prototype.getParameter;
    (WebGLRenderingContext as any).prototype.getParameter = function (p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, p);
    };
  } catch {}

  try {
    const origQuery = window.navigator.permissions.query.bind(
      window.navigator.permissions
    );
    (window.navigator.permissions as any).query = (parameters: any) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : origQuery(parameters);
  } catch {}
};

/* =========================================================
   SESSION MANAGER
========================================================= */

export interface SessionOptions {
  agentId: string;
  headless?: boolean;
  proxy?: { server: string; username?: string; password?: string };
  profileDir?: string;
  locale?: string;
  timezone?: string;
}

class BrowserSession {
  pages = new Map<string, Page>();
  activePageId: string | null = null;
  context!: BrowserContext;
  profilePath: string | null = null;

  constructor(public options: SessionOptions) {}

  async init() {
    const {
      agentId,
      headless = false,
      proxy,
      profileDir,
      locale = "en-US",
      timezone = "America/New_York",
    } = this.options;

    const baseDir = profileDir ?? path.join(PROFILES_DIR, agentId);
    this.profilePath = path.resolve(baseDir);
    await fs.mkdir(this.profilePath, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.profilePath, {
      headless,
      acceptDownloads: true,
      viewport: {
        width: 1280 + Math.floor(Math.random() * 100),
        height: 800,
      },
      locale,
      timezoneId: timezone,
      proxy,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });

    await this.context.addInitScript(stealthInitScript);

    for (const page of this.context.pages()) {
      this._attach(page);
    }
    if (this.pages.size === 0) {
      await this.newPage();
    }
  }

  async newPage(url?: string) {
    const page = await this.context.newPage();
    const id = this._attach(page);
    if (url) {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    return { id, page };
  }

  private _attach(page: Page): string {
    const id = `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.pages.set(id, page);
    if (!this.activePageId) this.activePageId = id;
    page.on("close", () => {
      this.pages.delete(id);
      if (this.activePageId === id) {
        const next = this.pages.keys().next();
        this.activePageId = next.done ? null : next.value;
      }
    });
    return id;
  }

  getPage(id?: string): Page {
    const target = id ?? this.activePageId;
    if (!target) throw new Error("No active page");
    const p = this.pages.get(target);
    if (!p) throw new Error(`Unknown tab: ${target}`);
    return p;
  }

  getPageById(id: string): Page {
    const p = this.pages.get(id);
    if (!p) throw new Error(`Unknown page/tab id: ${id}`);
    return p;
  }

  async destroy() {
    for (const p of this.pages.values()) await p.close().catch(() => {});
    this.pages.clear();
    this.activePageId = null;
    await this.context?.close().catch(() => {});
  }
}

class SessionManager {
  private sessions = new Map<string, BrowserSession>();

  async getOrCreate(agentId: string) {
    let s = this.sessions.get(agentId);
    if (!s) {
      s = new BrowserSession({ agentId });
      await s.init();
      this.sessions.set(agentId, s);
    }
    return s;
  }

  get(agentId: string) {
    return this.sessions.get(agentId);
  }

  async destroy(agentId: string) {
    const s = this.sessions.get(agentId);
    if (s) {
      await s.destroy();
      this.sessions.delete(agentId);
    }
  }

  list() {
    return [...this.sessions.keys()];
  }
}

const sessions = new SessionManager();

/* =========================================================
   HELPERS
========================================================= */

function jsonResponse(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const agentIdSchema = z
  .string()
  .min(1);


/* =========================================================
   CAPTCHA MODULE
========================================================= */

type CaptchaType =
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "hcaptcha"
  | "turnstile"
  | "image"
  | "none";

async function detectCaptcha(page: Page): Promise<CaptchaType> {
  return (await page.evaluate(() => {
    if (document.querySelector("iframe[src*='recaptcha/api2/anchor']"))
      return "recaptcha_v2";
    if (document.querySelector("iframe[src*='recaptcha/api2/bframe']"))
      return "recaptcha_v2";
    if (document.querySelector("iframe[src*='hcaptcha.com']")) return "hcaptcha";
    if (document.querySelector("iframe[src*='challenges.cloudflare.com']"))
      return "turnstile";
    if (
      document.querySelector(
        "img[src*='captcha'], #captcha-image, .captcha-img"
      )
    )
      return "image";
    return "none";
  })) as CaptchaType;
}

async function getSiteKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector("[data-sitekey]") as HTMLElement | null;
    return el?.getAttribute("data-sitekey") || null;
  });
}

async function solve2Captcha(params: Record<string, string>): Promise<string> {
  if (!CAPTCHA_ENABLED) throw new Error("CAPTCHA_API_KEY not configured");

  const submit = await axios.post("https://2captcha.com/in.php", null, {
    params: { key: CAPTCHA_KEY, json: 1, ...params },
  });

  if (submit.data.status !== 1)
    throw new Error(`2captcha submit: ${submit.data.request}`);

  const id = submit.data.request;

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await axios.get("https://2captcha.com/res.php", {
      params: { key: CAPTCHA_KEY, action: "get", id, json: 1 },
    });
    if (res.data.status === 1) return res.data.request as string;
    if (res.data.request !== "CAPCHA_NOT_READY")
      throw new Error(`2captcha poll: ${res.data.request}`);
  }
  throw new Error("CAPTCHA timeout");
}

async function injectRecaptcha(page: Page, token: string) {
  await page.evaluate((t) => {
    document
      .querySelectorAll<HTMLTextAreaElement>(
        "#g-recaptcha-response, textarea[name='g-recaptcha-response']"
      )
      .forEach((ta) => {
        ta.style.display = "block";
        ta.value = t;
      });
    const cfg = (window as any).___grecaptcha_cfg;
    if (cfg?.clients) {
      for (const c of Object.values(cfg.clients)) {
        for (const v of Object.values(c as any)) {
          const cb = (v as any)?.callback;
          if (typeof cb === "function") cb(t);
        }
      }
    }
  }, token);
}

async function injectHCaptcha(page: Page, token: string) {
  await page.evaluate((t) => {
    document
      .querySelectorAll<HTMLTextAreaElement>(
        "textarea[name='h-captcha-response'], textarea[name='g-recaptcha-response']"
      )
      .forEach((ta) => (ta.value = t));
    const cb = (window as any).__hcaptchaCallback;
    if (typeof cb === "function") cb(t);
  }, token);
}

async function injectTurnstile(page: Page, token: string) {
  await page.evaluate((t) => {
    document
      .querySelectorAll<HTMLInputElement>("input[name='cf-turnstile-response']")
      .forEach((i) => (i.value = t));
    const cb = (window as any).turnstileCallback;
    if (typeof cb === "function") cb(t);
  }, token);
}

async function tryCheckboxClick(page: Page): Promise<boolean> {
  try {
    const iframe = page.frameLocator(
      "iframe[title*='reCAPTCHA'], iframe[src*='recaptcha/api2/anchor']"
    );
    const checkbox = iframe.locator("#recaptcha-anchor");
    if ((await checkbox.count()) === 0) return false;

    const box = await checkbox.boundingBox();
    if (!box) return false;

    await humanMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(rnd(120, 320));
    await page.mouse.down();
    await page.waitForTimeout(rnd(40, 120));
    await page.mouse.up();

    await page.waitForTimeout(3000);

    return await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        "#g-recaptcha-response"
      );
      return !!(ta && ta.value.length > 20);
    });
  } catch {
    return false;
  }
}

async function solveCaptcha(
  page: Page
): Promise<{ type: CaptchaType; token?: string; solved: boolean }> {
  const type = await detectCaptcha(page);
  if (type === "none") return { type, solved: false };

  const url = page.url();
  const sitekey = await getSiteKey(page);

  if (type === "recaptcha_v2") {
    const ok = await tryCheckboxClick(page);
    if (ok) return { type, solved: true };

    if (!sitekey) return { type, solved: false };
    const token = await solve2Captcha({
      method: "userrecaptcha",
      googlekey: sitekey,
      pageurl: url,
    });
    await injectRecaptcha(page, token);
    return { type, token, solved: true };
  }

  if (type === "hcaptcha") {
    if (!sitekey) return { type, solved: false };
    const token = await solve2Captcha({
      method: "hcaptcha",
      sitekey,
      pageurl: url,
    });
    await injectHCaptcha(page, token);
    return { type, token, solved: true };
  }

  if (type === "turnstile") {
    if (!sitekey) return { type, solved: false };
    const token = await solve2Captcha({
      method: "turnstile",
      sitekey,
      pageurl: url,
    });
    await injectTurnstile(page, token);
    return { type, token, solved: true };
  }

  if (type === "image") {
    const img = page.locator("img[src*='captcha'], #captcha-image").first();
    const buf = await img.screenshot();
    const token = await solve2Captcha({
      method: "base64",
      body: buf.toString("base64"),
    });
    const input = page
      .locator("input[name*='captcha'], #captcha-input")
      .first();
    await input.fill(token).catch(() => {});
    return { type, token, solved: true };
  }

  return { type, solved: false };
}

/* =========================================================
   IDENTITY VAULT
========================================================= */

interface Identity {
  agentId: string;
  email: string;
  password: string;
  username?: string;
  tempInbox?: { address: string; password: string; token?: string };
  notes?: Record<string, string>;
}

async function loadOrCreateIdentity(agentId: string): Promise<Identity> {
  await fs.mkdir(VAULT_DIR, { recursive: true });
  const file = path.join(VAULT_DIR, `${agentId}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    const id: Identity = {
      agentId,
      email: `${agentId}-${crypto.randomBytes(4).toString("hex")}@example.com`,
      password: crypto.randomBytes(16).toString("base64url"),
      username: agentId,
    };
    await fs.writeFile(file, JSON.stringify(id, null, 2));
    return id;
  }
}

async function saveIdentity(identity: Identity) {
  await fs.mkdir(VAULT_DIR, { recursive: true });
  const file = path.join(VAULT_DIR, `${identity.agentId}.json`);
  await fs.writeFile(file, JSON.stringify(identity, null, 2));
}

async function createTempInbox(): Promise<{
  address: string;
  password: string;
  token: string;
}> {
  const domains = await axios
    .get("https://api.mail.tm/domains")
    .then((r) => r.data);
  const domain = domains["hydra:member"][0].domain;
  const address = `${crypto.randomBytes(4).toString("hex")}@${domain}`;
  const password = crypto.randomBytes(12).toString("base64url");

  await axios.post("https://api.mail.tm/accounts", { address, password });

  const login = await axios
    .post("https://api.mail.tm/token", { address, password })
    .then((r) => r.data);

  return { address, password, token: login.token };
}

async function waitForEmail(
  token: string,
  timeoutMs = 120000
): Promise<{ subject: string; intro: string; body: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await axios
      .get("https://api.mail.tm/messages", {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((r) => r.data);

    if (res["hydra:member"].length > 0) {
      const first = res["hydra:member"][0];
      const full = await axios
        .get(`https://api.mail.tm/messages/${first.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => r.data);

      const body = Array.isArray(full.html) ? full.html.join("\n") : full.html || full.text || "";
      return {
        subject: full.subject ?? "",
        intro: full.intro ?? "",
        body: typeof body === "string" ? body : JSON.stringify(body),
      };
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

/* =========================================================
   AGENT MESSAGING (in-memory)
========================================================= */

const inbox = new Map<string, string[]>();

/* =========================================================
   NAVIGATION TOOLS
========================================================= */

server.registerTool(
  "browser_navigate",
  {
    description: "Navigate the active tab of the agent's browser to a URL.",
    inputSchema: { agentId: agentIdSchema, url: z.string() },
  },
  async ({ agentId, url }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return jsonResponse({ url: p.url(), title: await p.title() });
  }
);

server.registerTool(
  "browser_inspect",
  {
    description:
      "Return interactive elements (buttons, inputs, links, etc.) and visible text.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const result = await p.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(
          "button, input, textarea, select, a, [role='button'], [role='link'], [contenteditable='true']"
        )
      );

      return {
        url: location.href,
        title: document.title,
        elements: elements.map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: (el.textContent || "").trim().slice(0, 300),
          ariaLabel: el.getAttribute("aria-label"),
          placeholder: el.getAttribute("placeholder"),
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
          value:
            "value" in el
              ? String((el as HTMLInputElement).value).slice(0, 300)
              : null,
          disabled:
            "disabled" in el
              ? Boolean((el as HTMLInputElement).disabled)
              : false,
        })),
        visibleText: document.body.innerText.slice(0, 10000),
      };
    });

    return jsonResponse(result);
  }
);

server.registerTool(
  "browser_click",
  {
    description: "Human-like click on element at inspection index.",
    inputSchema: {
      agentId: agentIdSchema,
      index: z.number().int().nonnegative(),
    },
  },
  async ({ agentId, index }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const locator = p
      .locator(
        "button, input, textarea, select, a, [role='button'], [role='link'], [contenteditable='true']"
      )
      .nth(index);

    await humanClickLocator(p, locator);
    return textResponse(`Clicked element ${index}`);
  }
);

server.registerTool(
  "browser_type",
  {
    description: "Human-like typing into an input or textarea.",
    inputSchema: {
      agentId: agentIdSchema,
      index: z.number().int().nonnegative(),
      text: z.string(),
    },
  },
  async ({ agentId, index, text }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const locator = p.locator("input, textarea, [contenteditable='true']").nth(index);

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(p, locator);
    await p.waitForTimeout(rnd(150, 400));

    for (const char of text) {
      await p.keyboard.type(char);
      const r = Math.random();
      const delay =
        r < 0.05 ? rnd(400, 800) : r < 0.2 ? rnd(120, 250) : rnd(40, 120);
      await p.waitForTimeout(delay);
    }

    return textResponse(`Typed text into element ${index}`);
  }
);

server.registerTool(
  "browser_select",
  {
    description: "Select an option from a select element.",
    inputSchema: {
      agentId: agentIdSchema,
      index: z.number().int().nonnegative(),
      value: z.string(),
    },
  },
  async ({ agentId, index, value }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const locator = p.locator("select").nth(index);
    await locator.selectOption(value);
    return textResponse(`Selected ${value}`);
  }
);

server.registerTool(
  "browser_scroll",
  {
    description: "Human-like scroll on the current page.",
    inputSchema: {
      agentId: agentIdSchema,
      direction: z.enum(["up", "down"]),
      amount: z.number().int().positive().default(700),
    },
  },
  async ({ agentId, direction, amount }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await humanScroll(p, direction === "down" ? amount : -amount);
    return textResponse(`Scrolled ${direction} by ${amount}px`);
  }
);

server.registerTool(
  "browser_read",
  {
    description: "Read the current visible webpage text.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const text = await p.locator("body").innerText();
    return textResponse(text.slice(0, 20000));
  }
);

/* =========================================================
   SCREENSHOT / WAIT / KEYS
========================================================= */

server.registerTool(
  "browser_screenshot",
  {
    description: "Take a screenshot of the active page.",
    inputSchema: {
      agentId: agentIdSchema,
      path: z.string().optional(),
      fullPage: z.boolean().default(false),
    },
  },
  async ({ agentId, path: outputPath, fullPage }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const screenshot = await p.screenshot({ path: outputPath, fullPage });
    return {
      content: [
        {
          type: "image" as const,
          data: screenshot.toString("base64"),
          mimeType: "image/png",
        },
      ],
    };
  }
);

server.registerTool(
  "browser_wait",
  {
    description: "Wait for a specified amount of time.",
    inputSchema: {
      agentId: agentIdSchema,
      milliseconds: z.number().int().nonnegative().max(120000),
    },
  },
  async ({ agentId, milliseconds }) => {
    await sessions.getOrCreate(agentId);
    await new Promise((r) => setTimeout(r, milliseconds));
    return textResponse(`Waited ${milliseconds}ms`);
  }
);

server.registerTool(
  "browser_keyboard",
  {
    description: "Press a keyboard key or type keyboard text.",
    inputSchema: {
      agentId: agentIdSchema,
      action: z.enum(["press", "type"]),
      value: z.string(),
    },
  },
  async ({ agentId, action, value }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    if (action === "press") await p.keyboard.press(value);
    else await p.keyboard.type(value);
    return textResponse(`Keyboard ${action}: ${value}`);
  }
);

server.registerTool(
  "browser_hover",
  {
    description: "Hover over an element (human-like motion).",
    inputSchema: { agentId: agentIdSchema, selector: z.string() },
  },
  async ({ agentId, selector }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const loc = p.locator(selector).first();
    const box = await loc.boundingBox();
    if (!box) throw new Error("Element not visible");
    await humanMoveTo(p, box.x + box.width / 2, box.y + box.height / 2);
    return textResponse(`Hovered over ${selector}`);
  }
);

server.registerTool(
  "browser_back",
  { description: "Navigate back.", inputSchema: { agentId: agentIdSchema } },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await p.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    return jsonResponse({ url: p.url(), title: await p.title() });
  }
);

server.registerTool(
  "browser_forward",
  { description: "Navigate forward.", inputSchema: { agentId: agentIdSchema } },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await p.goForward({ waitUntil: "domcontentloaded", timeout: 30000 });
    return jsonResponse({ url: p.url(), title: await p.title() });
  }
);

server.registerTool(
  "browser_reload",
  { description: "Reload the page.", inputSchema: { agentId: agentIdSchema } },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await p.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    return jsonResponse({ url: p.url(), title: await p.title() });
  }
);

/* =========================================================
   TABS
========================================================= */

server.registerTool(
  "browser_new_tab",
  {
    description: "Create a new browser tab.",
    inputSchema: { agentId: agentIdSchema, url: z.string().optional() },
  },
  async ({ agentId, url }) => {
    const s = await sessions.getOrCreate(agentId);
    const result = await s.newPage(url);
    return jsonResponse({
      tabId: result.id,
      url: result.page.url(),
      title: await result.page.title(),
    });
  }
);

server.registerTool(
  "browser_switch_tab",
  {
    description: "Switch the active tab.",
    inputSchema: { agentId: agentIdSchema, tabId: z.string() },
  },
  async ({ agentId, tabId }) => {
    const s = await sessions.getOrCreate(agentId);
    const page = s.getPageById(tabId);
    s.activePageId = tabId;
    await page.bringToFront();
    return jsonResponse({
      tabId,
      url: page.url(),
      title: await page.title(),
    });
  }
);

server.registerTool(
  "browser_close_tab",
  {
    description: "Close a tab.",
    inputSchema: { agentId: agentIdSchema, tabId: z.string().optional() },
  },
  async ({ agentId, tabId }) => {
    const s = await sessions.getOrCreate(agentId);
    const id = tabId || s.activePageId;
    if (!id) throw new Error("No active tab");
    const page = s.getPageById(id);
    await page.close();
    s.pages.delete(id);
    if (s.activePageId === id) {
      const next = s.pages.keys().next();
      s.activePageId = next.done ? null : next.value;
      if (s.activePageId) await s.pages.get(s.activePageId)!.bringToFront();
    }
    return textResponse(`Closed tab ${id}`);
  }
);

server.registerTool(
  "browser_list_tabs",
  { description: "List open tabs.", inputSchema: { agentId: agentIdSchema } },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const tabs = [];
    for (const [id, page] of s.pages.entries()) {
      tabs.push({
        tabId: id,
        active: id === s.activePageId,
        url: page.url(),
        title: await page.title().catch(() => ""),
      });
    }
    return jsonResponse(tabs);
  }
);

/* =========================================================
   SEMANTIC INSPECT / ELEMENT FIND / EXTRACT
========================================================= */

server.registerTool(
  "browser_inspect_semantic",
  {
    description:
      "Semantic inspection: roles, labels, states, stable element IDs.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const result = await p.evaluate(() => {
      const selectors = [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "option",
        "[role]",
        "[contenteditable='true']",
      ];

      const elements = Array.from(
        document.querySelectorAll(selectors.join(","))
      );

      return elements
        .map((el, index) => {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          const label =
            htmlEl.getAttribute("aria-label") ||
            htmlEl.getAttribute("title") ||
            (htmlEl as HTMLInputElement).placeholder ||
            htmlEl.textContent?.trim() ||
            "";

          return {
            id: `element_${index}`,
            tag: htmlEl.tagName.toLowerCase(),
            role:
              htmlEl.getAttribute("role") ||
              ({
                BUTTON: "button",
                A: "link",
                INPUT: "textbox",
                TEXTAREA: "textbox",
                SELECT: "combobox",
              } as Record<string, string>)[htmlEl.tagName] ||
              null,
            name: label.slice(0, 300),
            ariaLabel: htmlEl.getAttribute("aria-label"),
            placeholder: htmlEl.getAttribute("placeholder"),
            type: htmlEl.getAttribute("type"),
            nameAttribute: htmlEl.getAttribute("name"),
            value:
              "value" in htmlEl
                ? String((htmlEl as HTMLInputElement).value).slice(0, 300)
                : null,
            disabled:
              "disabled" in htmlEl
                ? Boolean((htmlEl as HTMLInputElement).disabled)
                : false,
            checked:
              "checked" in htmlEl
                ? Boolean((htmlEl as HTMLInputElement).checked)
                : false,
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(htmlEl).visibility !== "hidden" &&
              getComputedStyle(htmlEl).display !== "none",
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        })
        .filter((el) => el.visible);
    });

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
      elements: result,
    });
  }
);

server.registerTool(
  "browser_get_element",
  {
    description: "Find an element by css/text/role/label/placeholder.",
    inputSchema: {
      agentId: agentIdSchema,
      strategy: z.enum(["css", "text", "role", "label", "placeholder"]),
      value: z.string(),
    },
  },
  async ({ agentId, strategy, value }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    let locator;
    switch (strategy) {
      case "css":
        locator = p.locator(value);
        break;
      case "text":
        locator = p.getByText(value, { exact: false });
        break;
      case "role":
        locator = p.getByRole(value as Parameters<typeof p.getByRole>[0]);
        break;
      case "label":
        locator = p.getByLabel(value);
        break;
      case "placeholder":
        locator = p.getByPlaceholder(value);
        break;
    }

    const count = await locator.count();
    if (count === 0) return jsonResponse({ found: false, count: 0 });

    const first = locator.first();
    return jsonResponse({
      found: true,
      count,
      element: {
        tag: await first.evaluate((el) => el.tagName.toLowerCase()),
        text: (await first.textContent())?.trim().slice(0, 500),
        visible: await first.isVisible().catch(() => false),
        enabled: await first.isEnabled().catch(() => false),
      },
    });
  }
);

server.registerTool(
  "browser_extract",
  {
    description: "Extract structured data from elements matching a selector.",
    inputSchema: {
      agentId: agentIdSchema,
      selector: z.string(),
      fields: z
        .array(
          z.object({
            name: z.string(),
            selector: z.string().optional(),
            attribute: z.string().optional(),
          })
        )
        .min(1),
    },
  },
  async ({ agentId, selector, fields }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const data = await p.locator(selector).evaluateAll((elements, fields) => {
      return elements.map((element) => {
        const root = element as HTMLElement;
        const result: Record<string, string | null> = {};
        for (const field of fields as any[]) {
          const target = field.selector
            ? root.querySelector(field.selector)
            : root;
          if (!target) {
            result[field.name] = null;
            continue;
          }
          if (field.attribute) {
            result[field.name] = target.getAttribute(field.attribute);
          } else {
            result[field.name] = (target.textContent || "").trim();
          }
        }
        return result;
      });
    }, fields);

    return jsonResponse(data);
  }
);

/* =========================================================
   FORM / UPLOAD / DOWNLOAD
========================================================= */

server.registerTool(
  "browser_fill_form",
  {
    description: "Fill multiple form fields in one operation (human-paced).",
    inputSchema: {
      agentId: agentIdSchema,
      fields: z
        .array(z.object({ selector: z.string(), value: z.string() }))
        .min(1),
    },
  },
  async ({ agentId, fields }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const results = [];
    for (const field of fields) {
      await humanType(p, field.selector, field.value);
      results.push({ selector: field.selector, filled: true });
    }
    return jsonResponse(results);
  }
);

server.registerTool(
  "browser_upload_file",
  {
    description: "Upload one or more files to a file input.",
    inputSchema: {
      agentId: agentIdSchema,
      selector: z.string(),
      files: z.array(z.string()).min(1),
    },
  },
  async ({ agentId, selector, files }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const resolvedFiles = files.map((file) => path.resolve(file));
    for (const file of resolvedFiles) await fs.access(file);
    await p.locator(selector).setInputFiles(resolvedFiles);

    return jsonResponse({ selector, files: resolvedFiles });
  }
);

server.registerTool(
  "browser_download",
  {
    description: "Click a download element and save the resulting file.",
    inputSchema: {
      agentId: agentIdSchema,
      selector: z.string(),
      path: z.string().optional(),
    },
  },
  async ({ agentId, selector, path: outputPath }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const downloadPromise = p.waitForEvent("download");
    const loc = p.locator(selector).first();
    await humanClickLocator(p, loc);
    const download = await downloadPromise;

    const suggestedName = download.suggestedFilename();
    const finalPath =
      outputPath || path.join(process.cwd(), "downloads", suggestedName);

    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await download.saveAs(finalPath);

    return jsonResponse({
      path: finalPath,
      filename: suggestedName,
      failure: await download.failure(),
    });
  }
);

/* =========================================================
   WAIT HELPERS
========================================================= */

server.registerTool(
  "browser_wait_for_element",
  {
    description: "Wait until an element reaches the requested state.",
    inputSchema: {
      agentId: agentIdSchema,
      selector: z.string(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
      timeout: z.number().int().positive().default(30000),
    },
  },
  async ({ agentId, selector, state, timeout }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await p.locator(selector).waitFor({ state, timeout });
    return textResponse(`Element ${selector} reached state ${state}`);
  }
);

server.registerTool(
  "browser_wait_for_text",
  {
    description: "Wait until text appears on the page.",
    inputSchema: {
      agentId: agentIdSchema,
      text: z.string(),
      timeout: z.number().int().positive().default(30000),
    },
  },
  async ({ agentId, text, timeout }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    await p
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout });
    return textResponse(`Text appeared: ${text}`);
  }
);

server.registerTool(
  "browser_wait_for_navigation",
  {
    description: "Wait for browser navigation to complete.",
    inputSchema: {
      agentId: agentIdSchema,
      url: z.string().optional(),
      timeout: z.number().int().positive().default(30000),
    },
  },
  async ({ agentId, url, timeout }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    if (url) {
      await p.waitForURL(url, { timeout, waitUntil: "domcontentloaded" });
    } else {
      await p.waitForLoadState("domcontentloaded", { timeout });
    }
    return jsonResponse({ url: p.url(), title: await p.title() });
  }
);

/* =========================================================
   PERMISSIONS / SESSION
========================================================= */

server.registerTool(
  "browser_permissions",
  {
    description: "Grant or clear browser permissions for an origin.",
    inputSchema: {
      agentId: agentIdSchema,
      action: z.enum(["grant", "clear"]),
      origin: z.string(),
      permissions: z.array(z.string()).optional(),
    },
  },
  async ({ agentId, action, origin, permissions }) => {
    const s = await sessions.getOrCreate(agentId);
    if (action === "grant") {
      if (!permissions || permissions.length === 0)
        throw new Error("permissions are required when action=grant");
      await s.context.grantPermissions(permissions, { origin });
      return jsonResponse({ action, origin, permissions });
    }
    await s.context.clearPermissions();
    return jsonResponse({ action, origin });
  }
);

server.registerTool(
  "browser_session",
  {
    description: "Inspect or manage the agent's browser session.",
    inputSchema: {
      agentId: agentIdSchema,
      action: z.enum(["info", "close", "clear_cookies", "clear_permissions"]),
    },
  },
  async ({ agentId, action }) => {
    if (action === "close") {
      await sessions.destroy(agentId);
      return textResponse(`Browser session for ${agentId} closed`);
    }

    const s = await sessions.getOrCreate(agentId);

    if (action === "clear_cookies") {
      await s.context.clearCookies();
      return textResponse("Cookies cleared");
    }
    if (action === "clear_permissions") {
      await s.context.clearPermissions();
      return textResponse("Permissions cleared");
    }

    return jsonResponse({
      agentId,
      activePageId: s.activePageId,
      tabs: s.pages.size,
      profilePath: s.profilePath,
    });
  }
);

server.registerTool(
  "browser_list_sessions",
  {
    description: "List all active agent sessions on this server.",
    inputSchema: {},
  },
  async () => jsonResponse({ sessions: sessions.list() })
);

/* =========================================================
   PROFILE
========================================================= */

server.registerTool(
  "browser_profile",
  {
    description: "Inspect the agent's persistent profile path.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    return jsonResponse({ profilePath: s.profilePath, persistent: true });
  }
);

/* =========================================================
   CAPTCHA TOOLS
========================================================= */

server.registerTool(
  "captcha_detect",
  {
    description: "Detect the CAPTCHA type present on the active page.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const type = await detectCaptcha(s.getPage());
    return jsonResponse({ type, enabled: CAPTCHA_ENABLED });
  }
);

server.registerTool(
  "captcha_solve",
  {
    description:
      "Detect and solve any CAPTCHA on the active page (checkbox, reCAPTCHA, hCaptcha, Turnstile, image).",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const s = await sessions.getOrCreate(agentId);
    const result = await solveCaptcha(s.getPage());
    return jsonResponse(result);
  }
);

server.registerTool(
  "browser_click_and_solve",
  {
    description:
      "Human-like click on element index, wait, then attempt to auto-solve any CAPTCHA that appears.",
    inputSchema: {
      agentId: agentIdSchema,
      index: z.number().int().nonnegative(),
    },
  },
  async ({ agentId, index }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();

    const locator = p
      .locator("button, a, [role='button'], input[type='submit']")
      .nth(index);
    await humanClickLocator(p, locator);
    await p.waitForTimeout(2500);

    const result = await solveCaptcha(p);
    return jsonResponse(result);
  }
);

/* =========================================================
   IDENTITY / ACCOUNT TOOLS
========================================================= */

server.registerTool(
  "identity_get",
  {
    description: "Get the agent's stored identity (email/password).",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const identity = await loadOrCreateIdentity(agentId);
    return jsonResponse(identity);
  }
);

server.registerTool(
  "identity_create_inbox",
  {
    description:
      "Create a temporary email inbox and attach it to the agent identity.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const identity = await loadOrCreateIdentity(agentId);
    const inboxInfo = await createTempInbox();
    identity.email = inboxInfo.address;
    identity.tempInbox = {
      address: inboxInfo.address,
      password: inboxInfo.password,
      token: inboxInfo.token,
    };
    await saveIdentity(identity);
    return jsonResponse({
      email: identity.email,
      password: identity.tempInbox.password,
    });
  }
);

server.registerTool(
  "identity_wait_email",
  {
    description:
      "Wait for an email to arrive at the agent's temp inbox (returns subject + body).",
    inputSchema: {
      agentId: agentIdSchema,
      timeoutMs: z.number().int().positive().default(120000),
    },
  },
  async ({ agentId, timeoutMs }) => {
    const identity = await loadOrCreateIdentity(agentId);
    if (!identity.tempInbox?.token)
      throw new Error("No temp inbox attached. Run identity_create_inbox first.");

    const mail = await waitForEmail(identity.tempInbox.token, timeoutMs);
    if (!mail) return jsonResponse({ received: false });
    return jsonResponse({ received: true, ...mail });
  }
);

server.registerTool(
  "account_signup",
  {
    description:
      "Fill a signup form using the agent's identity, then auto-solve CAPTCHA and submit.",
    inputSchema: {
      agentId: agentIdSchema,
      emailSelector: z.string(),
      passwordSelector: z.string(),
      confirmSelector: z.string().optional(),
      submitSelector: z.string(),
      extraFields: z
        .array(z.object({ selector: z.string(), value: z.string() }))
        .optional(),
    },
  },
  async ({
    agentId,
    emailSelector,
    passwordSelector,
    confirmSelector,
    submitSelector,
    extraFields,
  }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const id = await loadOrCreateIdentity(agentId);

    await humanType(p, emailSelector, id.email);
    await humanType(p, passwordSelector, id.password);
    if (confirmSelector) await humanType(p, confirmSelector, id.password);

    if (extraFields) {
      for (const f of extraFields) await humanType(p, f.selector, f.value);
    }

    // Try checkbox tick, else full solve
    const ticked = await tryCheckboxClick(p);
    if (!ticked) {
      try {
        await solveCaptcha(p);
      } catch (e) {
        // continue even if captcha fails; user may handle manually
      }
    }

    await humanClickLocator(p, p.locator(submitSelector).first());
    await p.waitForTimeout(3000);

    return jsonResponse({
      email: id.email,
      url: p.url(),
      title: await p.title(),
    });
  }
);

server.registerTool(
  "account_signin",
  {
    description: "Fill a signin form using the agent's stored identity.",
    inputSchema: {
      agentId: agentIdSchema,
      emailSelector: z.string(),
      passwordSelector: z.string(),
      submitSelector: z.string(),
    },
  },
  async ({ agentId, emailSelector, passwordSelector, submitSelector }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const id = await loadOrCreateIdentity(agentId);

    await humanType(p, emailSelector, id.email);
    await humanType(p, passwordSelector, id.password);

    const ticked = await tryCheckboxClick(p);
    if (!ticked) {
      try {
        await solveCaptcha(p);
      } catch {}
    }

    await humanClickLocator(p, p.locator(submitSelector).first());
    await p.waitForTimeout(3000);

    return jsonResponse({ url: p.url(), title: await p.title() });
  }
);

/* =========================================================
   AGENT MESSAGING
========================================================= */

server.registerTool(
  "agent_send",
  {
    description: "Send a message to another agent (in-memory bus).",
    inputSchema: {
      from: z.string(),
      to: z.string(),
      message: z.string(),
    },
  },
  async ({ from, to, message }) => {
    const list = inbox.get(to) ?? [];
    list.push(`[${new Date().toISOString()}] [${from}] ${message}`);
    inbox.set(to, list);
    return textResponse("sent");
  }
);

server.registerTool(
  "agent_receive",
  {
    description: "Receive and clear pending messages for this agent.",
    inputSchema: { agentId: agentIdSchema },
  },
  async ({ agentId }) => {
    const list = inbox.get(agentId) ?? [];
    inbox.set(agentId, []);
    return jsonResponse(list);
  }
);

/* =========================================================
   HIGH-LEVEL TASK
========================================================= */

const taskActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string() }),
  z.object({ action: z.literal("click"), selector: z.string() }),
  z.object({ action: z.literal("type"), selector: z.string(), text: z.string() }),
  z.object({ action: z.literal("fill"), selector: z.string(), text: z.string() }),
  z.object({ action: z.literal("hover"), selector: z.string() }),
  z.object({ action: z.literal("wait"), milliseconds: z.number().int().nonnegative() }),
  z.object({
    action: z.literal("wait_for_element"),
    selector: z.string(),
    state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
  }),
  z.object({ action: z.literal("wait_for_text"), text: z.string() }),
  z.object({ action: z.literal("press"), key: z.string() }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().default(700),
  }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("forward") }),
  z.object({ action: z.literal("reload") }),
  z.object({ action: z.literal("solve_captcha") }),
]);

server.registerTool(
  "browser_task",
  {
    description: "Execute a sequence of browser actions as one high-level task.",
    inputSchema: {
      agentId: agentIdSchema,
      actions: z.array(taskActionSchema).min(1).max(100),
    },
  },
  async ({ agentId, actions }) => {
    const s = await sessions.getOrCreate(agentId);
    const p = s.getPage();
    const results: unknown[] = [];

    for (const action of actions) {
      switch (action.action) {
        case "navigate":
          await p.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          results.push({ action: "navigate", url: p.url() });
          break;

        case "click": {
          const loc = p.locator(action.selector).first();
          await humanClickLocator(p, loc);
          results.push({ action: "click", selector: action.selector });
          break;
        }

        case "type":
        case "fill":
          await humanType(p, action.selector, action.text);
          results.push({ action: action.action, selector: action.selector });
          break;

        case "hover": {
          const loc = p.locator(action.selector).first();
          const box = await loc.boundingBox();
          if (box) await humanMoveTo(p, box.x + box.width / 2, box.y + box.height / 2);
          results.push({ action: "hover", selector: action.selector });
          break;
        }

        case "wait":
          await new Promise((r) => setTimeout(r, action.milliseconds));
          results.push({ action: "wait", milliseconds: action.milliseconds });
          break;

        case "wait_for_element":
          await p.locator(action.selector).waitFor({ state: action.state, timeout: 30000 });
          results.push({ action: "wait_for_element", selector: action.selector });
          break;

        case "wait_for_text":
          await p.getByText(action.text, { exact: false }).first().waitFor({
            state: "visible",
            timeout: 30000,
          });
          results.push({ action: "wait_for_text", text: action.text });
          break;

        case "press":
          await p.keyboard.press(action.key);
          results.push({ action: "press", key: action.key });
          break;

        case "scroll":
          await humanScroll(p, action.direction === "down" ? action.amount : -action.amount);
          results.push({ action: "scroll", direction: action.direction });
          break;

        case "back":
          await p.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
          results.push({ action: "back", url: p.url() });
          break;

        case "forward":
          await p.goForward({ waitUntil: "domcontentloaded", timeout: 30000 });
          results.push({ action: "forward", url: p.url() });
          break;

        case "reload":
          await p.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
          results.push({ action: "reload", url: p.url() });
          break;

        case "solve_captcha": {
          const r = await solveCaptcha(p);
          results.push({ action: "solve_captcha", ...r });
          break;
        }
      }
    }

    return jsonResponse({
      success: true,
      results,
      final: { url: p.url(), title: await p.title() },
    });
  }
);

/* =========================================================
   HTTP SERVER
========================================================= */

const httpServer = createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "web-agent-mcp",
          version: "0.3.0",
          sessions: sessions.list(),
          captchaEnabled: CAPTCHA_ENABLED,
        })
      );
      return;
    }

    if (req.url === "/mcp") {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Agent MCP v0.3.0 running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`CAPTCHA solving: ${CAPTCHA_ENABLED ? "enabled" : "disabled"}`);
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown() {
  console.log("Shutting down...");
  for (const id of sessions.list()) {
    await sessions.destroy(id).catch(() => {});
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);