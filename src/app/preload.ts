import { contextBridge, ipcRenderer } from "electron";

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("api", {
  brief: (view: string) => call("brief", view),
  sync: () => call("sync"),
  status: () => call("status"),
  tasks: () => call("tasks"),
  addTask: (t: unknown) => call("addTask", t),
  setTask: (id: string, status: string) => call("setTask", id, status),
  projects: () => call("projects"),
  addProject: (p: unknown) => call("addProject", p),
  endDay: () => call("endDay"),
  toggleProvider: (id: string, on: boolean) => call("toggleProvider", id, on),
  connectGoogle: (clientId: string) => call("connectGoogle", clientId),
  setApiKey: (key: string) => call("setApiKey", key),
  summarize: (view: string) => call("summarize", view),
});
