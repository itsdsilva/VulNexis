import { invoke } from '@tauri-apps/api/core';
import { inTauri } from './llm';

const DESKTOP_ONLY = 'Built-in browser requires the desktop app — run "npm run tauri dev" or launch the installed VulNexis.';

export async function browserLaunch(headless = true) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>('browser_launch', { req: headless ? { headless } : null });
}

export async function browserNavigate(url: string) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>('browser_navigate', { req: { url } });
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  html: string;
  forms: any[];
  links: string[];
  inputs: any[];
}

export async function browserSnapshot(): Promise<BrowserSnapshot> {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<BrowserSnapshot>('browser_snapshot');
}

export async function browserClick(opts: { selector?: string; text?: string }) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>('browser_click', { req: opts });
}

export async function browserType(selector: string, value: string) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>('browser_type', { req: { selector, value } });
}

export async function browserEval(script: string) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<any>('browser_eval', { req: { script } });
}

export async function browserGetCookies() {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<any>('browser_get_cookies');
}

export async function browserScreenshot() {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>('browser_screenshot');
}

export async function browserClose() {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>('browser_close');
}
