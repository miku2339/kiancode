import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { requireScope } from '../auth.js';
import { DomainError, type ToolContext, type ToolDefinition, type ToolSpecification } from '../contracts.js';

export interface BrowserToolOptions {
  permission: 'configured';
  executablePath: string;
  allowedOrigins: string[];
  headless?: boolean;
  maxSnapshotCharacters?: number;
}

export interface BrowserHealth {
  available: boolean;
  executablePath: string;
  reason?: string;
}

function requireCapability(context: ToolContext): void {
  requireScope(context.principal, 'browser:automation');
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required };
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new DomainError('invalid_input', `${key} must be a non-empty string`);
  return value;
}

export const browserToolSpecifications = [
  {
    name: 'browser.navigate',
    description: 'Navigate the temporary browser context to a configured HTTP origin.',
    inputSchema: schema({ url: { type: 'string', format: 'uri' } }, ['url']),
    requiredCapabilities: ['browser:automation'],
    requiresWorkspace: true,
    sideEffect: 'external',
  },
  {
    name: 'browser.snapshot',
    description: 'Read the current page title, visible text, and accessibility snapshot.',
    inputSchema: schema({}),
    requiredCapabilities: ['browser:automation'],
    requiresWorkspace: true,
    sideEffect: 'read',
  },
  {
    name: 'browser.click',
    description: 'Click one element selected by a Playwright selector in the temporary browser context.',
    inputSchema: schema({ selector: { type: 'string', minLength: 1 } }, ['selector']),
    requiredCapabilities: ['browser:automation'],
    requiresWorkspace: true,
    sideEffect: 'external',
  },
  {
    name: 'browser.fill',
    description: 'Fill one editable element selected by a Playwright selector in the temporary browser context.',
    inputSchema: schema({ selector: { type: 'string', minLength: 1 }, value: { type: 'string' } }, ['selector', 'value']),
    requiredCapabilities: ['browser:automation'],
    requiresWorkspace: true,
    sideEffect: 'external',
  },
] as const satisfies readonly ToolSpecification[];

export async function probeBrowserAutomation(executablePath: string): Promise<BrowserHealth> {
  try {
    await access(executablePath, fsConstants.X_OK);
    const browser = await chromium.launch({ executablePath, headless: true });
    await browser.close();
    return { available: true, executablePath };
  } catch (error) {
    return {
      available: false,
      executablePath,
      reason: error instanceof Error ? error.message : 'Browser launch failed',
    };
  }
}

export class BrowserToolProvider {
  private page?: Page;

  private constructor(
    private readonly options: BrowserToolOptions,
    private readonly browser: Browser,
    private readonly browserContext: BrowserContext,
    private readonly origins: Set<string>,
  ) {}

  static async launch(options: BrowserToolOptions): Promise<BrowserToolProvider> {
    if (options.permission !== 'configured') throw new DomainError('browser_permission_required', 'Browser requires explicit configured permission', 403);
    if (options.allowedOrigins.length === 0) throw new DomainError('invalid_browser_config', 'At least one allowed origin is required');
    await access(options.executablePath, fsConstants.X_OK).catch(() => {
      throw new DomainError('browser_unavailable', 'Configured browser executable is unavailable', 503);
    });
    const origins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
    const browser = await chromium.launch({
      executablePath: options.executablePath,
      headless: options.headless ?? true,
      args: ['--no-first-run', '--no-default-browser-check'],
    }).catch((error: unknown) => {
      throw new DomainError('browser_unavailable', error instanceof Error ? error.message : 'Browser launch failed', 503);
    });
    const browserContext = await browser.newContext();
    await browserContext.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) {
        await route.continue();
        return;
      }
      try {
        if (origins.has(new URL(url).origin)) await route.continue();
        else await route.abort('blockedbyclient');
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    return new BrowserToolProvider(options, browser, browserContext, origins);
  }

  private async currentPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) this.page = await this.browserContext.newPage();
    return this.page;
  }

  private allowedUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new DomainError('invalid_input', 'url must be an absolute HTTP or HTTPS URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || !this.origins.has(url.origin)) {
      throw new DomainError('browser_origin_forbidden', 'URL origin is not configured for this browser', 403);
    }
    return url;
  }

  private async closeExtraPages(): Promise<void> {
    for (const page of this.browserContext.pages()) {
      if (page !== this.page) await page.close();
    }
  }

  private async action<T>(context: ToolContext, operation: () => Promise<T>): Promise<T> {
    if (context.signal.aborted) throw new DomainError('browser_aborted', 'Browser action was cancelled', 499);
    const abort = (): void => { void this.page?.close(); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      return await operation();
    } catch (error) {
      if (context.signal.aborted) throw new DomainError('browser_aborted', 'Browser action was cancelled', 499);
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abort);
    }
  }

  tools(): ToolDefinition[] {
    const navigate: ToolDefinition = {
      ...browserToolSpecifications[0],
      execute: async (input, context) => {
        requireCapability(context);
        const url = this.allowedUrl(stringInput(input, 'url'));
        const page = await this.currentPage();
        const response = await this.action(context, () => page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
        const finalUrl = this.allowedUrl(page.url());
        return { content: JSON.stringify({ url: finalUrl.href, title: await page.title(), status: response?.status() ?? null }) };
      },
    };

    const snapshot: ToolDefinition = {
      ...browserToolSpecifications[1],
      execute: async (_input, context) => {
        requireCapability(context);
        const page = await this.currentPage();
        if (page.url() !== 'about:blank') this.allowedUrl(page.url());
        const maximum = this.options.maxSnapshotCharacters ?? 100_000;
        const visibleText = (await this.action(context, () => page.locator('body').innerText())).slice(0, maximum);
        const accessibility = (await this.action(context, () => page.locator('body').ariaSnapshot())).slice(0, maximum);
        return { content: JSON.stringify({ url: page.url(), title: await page.title(), visibleText, accessibility }) };
      },
    };

    const click: ToolDefinition = {
      ...browserToolSpecifications[2],
      execute: async (input, context) => {
        requireCapability(context);
        const page = await this.currentPage();
        await this.action(context, () => page.locator(stringInput(input, 'selector')).click({ timeout: 15_000 }));
        await this.closeExtraPages();
        if (page.url() !== 'about:blank') this.allowedUrl(page.url());
        return { content: JSON.stringify({ clicked: true, url: page.url() }) };
      },
    };

    const fill: ToolDefinition = {
      ...browserToolSpecifications[3],
      execute: async (input, context) => {
        requireCapability(context);
        const page = await this.currentPage();
        if (typeof input.value !== 'string') throw new DomainError('invalid_input', 'value must be a string');
        await this.action(context, () => page.locator(stringInput(input, 'selector')).fill(input.value as string, { timeout: 15_000 }));
        return { content: JSON.stringify({ filled: true, url: page.url() }) };
      },
    };

    return [navigate, snapshot, click, fill];
  }

  asToolDefinitions(): ToolDefinition[] {
    return this.tools();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
