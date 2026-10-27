// DOM interactions with VS Code's out-of-process webview, in the isolated demo only.
// Uses the public CDP transport; does not change HTML, CSS, data or production code.
export async function webviewDriver(browser, wantedTitle) {
  const root = await browser.newBrowserCDPSession();
  const targets = (await root.send("Target.getTargets")).targetInfos
    .filter(t => t.type === "iframe" && t.url.includes("extensionId=whwitpohe.linyra"));
  for (const target of targets) {
    const { sessionId } = await root.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    let sequence = 0;
    const pending = new Map();
    const listener = event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      const wait = pending.get(message.id);
      if (!wait) return;
      pending.delete(message.id);
      if (message.error) wait.reject(new Error(message.error.message));
      else wait.resolve(message.result);
    };
    root.on("Target.receivedMessageFromTarget", listener);
    async function evaluate(body) {
      const id = ++sequence;
      let timer;
      const response = new Promise((resolve,reject) => {
        pending.set(id,{resolve,reject});
        timer=setTimeout(()=>{pending.delete(id);reject(new Error("Recording webview did not respond"));},10000);
      });
      await root.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method: "Runtime.evaluate", params: {
        expression: `(() => { const doc = document.getElementById('active-frame')?.contentDocument; if (!doc) return null; ${body} })()`,
        returnByValue: true, awaitPromise: true,
      } }) });
      const result = await response.finally(()=>clearTimeout(timer));
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result?.value;
    }
    const title = await evaluate("return doc.title;");
    if (title === wantedTitle) return {
      evaluate,
      click: selector => evaluate(`const node = doc.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing recording control'); node.click(); return true;`),
      fill: (selector,value) => evaluate(`const node = doc.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing recording input'); node.focus(); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true})); return true;`),
      key: (selector,key) => evaluate(`const node = doc.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing recording control'); node.focus(); node.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true})); return true;`),
      close: () => root.detach(),
    };
    root.off("Target.receivedMessageFromTarget",listener);
    await root.send("Target.detachFromTarget", { sessionId });
  }
  await root.detach();
  throw new Error(`No live webview titled ${wantedTitle}`);
}
