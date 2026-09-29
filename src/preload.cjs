const { contextBridge, ipcRenderer } = require("electron");

const call = (name) => (...a) => ipcRenderer.invoke(name, ...a);
const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, d) => fn(d));

contextBridge.exposeInMainWorld("midnight", {
	init: call("init"),
	size: call("size"),
	dims: call("dims"),
	copy: call("copy"),
	clipboard: call("clipboard"),
	textSize: call("text-size"),
	focus: call("focus"),
	send: call("send"),
	abort: call("abort"),
	reset: call("reset"),
	decide: call("decide"),
	peek: call("peek"),
	openExternal: call("open-external"),
	settings: {
		get: call("settings:get"),
		set: call("settings:set"),
		login: call("settings:login"),
		cancelLogin: call("settings:cancel-login"),
		logout: call("settings:logout"),
		clearBrowser: call("settings:clear-browser"),
		openData: call("settings:open-data"),
	},
	onAgent: on("agent"),
	onOverlay: on("overlay"),
});
