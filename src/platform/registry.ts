import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Router } from 'express';
import type { UnityService } from '../unity/services/unity.service';
import type { NavItem } from './shell';

/**
 * Drawbridge platform modules.
 *
 * A module is one feature (on-call notebook, huddle brief, outreach, staff assistant, ...). It can:
 *  - expose agent tools (Retell custom functions / MCP tools) via getTools() + run()
 *  - mount staff screens under /app/<path> (login is enforced by the platform before your router)
 *  - mount machine endpoints under /api/<name> (webhooks, schedulers) via apiRouter()
 *
 * Modules never call Veradigm directly except through ctx.unity (UnityService) or the existing
 * tool classes, so error handling, action-name config and logging stay in one place.
 */
export interface ToolContext {
  callId?: string;
  callerPhone?: string;
}

export interface PlatformDeps {
  unity: UnityService;
  /** Run any registered agent tool by name (same path Retell uses: structured errors, idempotency, audit). */
  runTool: (name: string, args: any, ctx?: ToolContext) => Promise<any>;
}

export interface PlatformModule {
  name: string;
  /** Agent tools this module adds. Names must be unique; use the unity_ prefix for Veradigm tools, drawbridge_ for platform tools. */
  getTools?(): Tool[];
  /** Run one of this module's tools. Throw on failure; the platform converts errors to { success:false, error_code, retryable }. */
  run?(name: string, args: any, ctx: ToolContext): Promise<any>;
  /** Tools that change Veradigm data (get idempotency + read-back rules). */
  writeTools?: string[];
  /** Staff screens, mounted at /app<nav.path> behind login. */
  nav?: NavItem;
  appRouter?(deps: PlatformDeps): Router;
  /** Machine endpoints mounted at /api/<name> (no staff login; protect with DRAWBRIDGE_API_KEY). */
  apiRouter?(deps: PlatformDeps): Router;
  /** Background jobs (schedulers). Called once at startup. */
  start?(deps: PlatformDeps): void;
}

const modules: PlatformModule[] = [];

export function registerModule(m: PlatformModule): void {
  if (modules.some((x) => x.name === m.name)) throw new Error(`Duplicate platform module ${m.name}`);
  modules.push(m);
}

export function platformModules(): PlatformModule[] {
  return [...modules];
}

export function moduleForTool(name: string): PlatformModule | undefined {
  return modules.find((m) => m.getTools?.().some((t) => t.name === name));
}

export function platformTools(): Tool[] {
  return modules.flatMap((m) => m.getTools?.() || []);
}

export function platformWriteTools(): string[] {
  return modules.flatMap((m) => m.writeTools || []);
}
