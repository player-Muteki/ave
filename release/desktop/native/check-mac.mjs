import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {_electron} from "playwright-core";

// Exercise the installed renderer, IPC sender validation, and OAuth cancellation.
// The account holder performs the separate real-account acceptance.
const profile=await mkdtemp(path.join(os.tmpdir(),"ave-installed-"));
let app;
try {
  app=await _electron.launch({executablePath:process.argv[2],args:["--user-data-dir="+profile],timeout:30000});
  const page=await app.firstWindow();
  await page.getByText(/已连接/).first().waitFor();
  await app.evaluate(({shell})=>{
    shell.openExternal=async(url)=>{
      const authorize=new URL(url);
      if(authorize.origin!=="https://auth.openai.com" || authorize.searchParams.get("agent_name_hint")!=="AVE") throw Error("Invalid authorization URL");
      globalThis.aveSmokeStarted=true;
    };
  });
  await page.getByRole("button",{name:"使用 ChatGPT 继续"}).click();
  for(let i=0;i<100 && !await app.evaluate(()=>Boolean(globalThis.aveSmokeStarted));i++){
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(await app.evaluate(()=>Boolean(globalThis.aveSmokeStarted)));
  await page.getByRole("button",{name:"取消登录"}).click();
  await page.getByRole("button",{name:"取消登录"}).waitFor({state:"hidden"});
  assert.equal((await page.evaluate(()=>window.aveDesktop.accountStatus())).account,null);
  console.log("Installed Mac desktop connected to its daemon and cancelled the browser authorization.");
} finally {
  await app?.close();
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
