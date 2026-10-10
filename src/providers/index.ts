import { AppleMailProvider } from "./apple-mail.ts";
import { OutlookProvider } from "./outlook.ts";
import type { Provider } from "./types.ts";

/** Local mail clients that can be offered on this OS. Google is added separately after OAuth. */
export function localProviders(platform: NodeJS.Platform = process.platform): Provider[] {
  if (platform === "darwin") return [new AppleMailProvider()];
  if (platform === "win32") return [new OutlookProvider()];
  return [];
}

export type { ExternalTask, Provider } from "./types.ts";
