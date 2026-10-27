import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./llm";

export interface ToolInfo {
  name: string;
  available: boolean;
  path: string;
}

const DESKTOP_ONLY = 'Kali tools require the desktop app — run "npm run tauri dev" or launch the installed VulNexis.';

export async function sshConnect(host: string, port: number, username: string, password: string) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>("ssh_connect", { host, port, username, password });
}

export async function sshDisconnect() {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>("ssh_disconnect");
}

export async function sshExec(command: string) {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<string>("ssh_exec", { command });
}

export async function sshDetectTools() {
  if (!inTauri()) throw new Error(DESKTOP_ONLY);
  return await invoke<ToolInfo[]>("ssh_detect_tools");
}
