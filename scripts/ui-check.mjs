// Interaction regressions against the actual renderer, with delayed/rejected bridge responses.
import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
ipcMain.handle("fixture:size", () => null);

app.whenReady().then(async () => {
	const win = new BrowserWindow({ width: 1300, height: 1400, show: false, webPreferences: { preload: path.join(root, "test/visual/preload.cjs"), contextIsolation: true, sandbox: true, offscreen: true } });
	const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
	const errors = [];
	win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === 3) errors.push(e.message); });
	const reset = async () => { errors.length = 0; await win.loadFile(path.join(root, "src/ui/index.html")); await sleep(250); };
	const calls = (method) => js(`return __fixture.calls().filter(c => c.method === ${JSON.stringify(method)});`);
	const tests = [
		["ready refreshes model availability", async () => {
			await js(`signedIn = false; engine = 'starting'; __fixture.variant('done');`);
			await sleep(100);
			assert.equal(await js("return signedIn;"), true);
			assert.notEqual(await js("return document.getElementById('chipModel').textContent;"), "no model");
		}],
		["old snapshot replies cannot undo newer updates", async () => {
			await js(`const old = structuredClone(snap); old.seq = 2; __fixture.configure({'query.snapshot': {result: old, delay: 200}}); resnapshot(); resnapshot(); for(let seq=2;seq<=5;seq++) applyUpdate({kind:'update',seq,type:'mission.titled',missionId:'m1',mission:{...snap.missions.m1,title:'New title'}});`);
			await sleep(300);
			assert.deepEqual(await js("return {seq:snap.seq,title:snap.missions.m1.title};"), { seq: 5, title: "New title" });
			assert.equal((await calls("query.snapshot")).length, 2); // initial load + one coalesced request
		}],
		["update gaps retain events arriving after the snapshot was captured", async () => {
			await js(`const s = structuredClone(snap); s.seq=3; __fixture.configure({'query.snapshot':{result:s,delay:100}}); applyUpdate({seq:3,type:'mission.titled',missionId:'m1',mission:{...s.missions.m1,title:'At snapshot'}}); applyUpdate({seq:4,type:'mission.titled',missionId:'m1',mission:{...s.missions.m1,title:'After snapshot'}});`);
			await sleep(200);
			assert.deepEqual(await js("return {seq:snap.seq,title:snap.missions.m1.title};"), { seq: 4, title: "After snapshot" });
		}],
		["dashboard renders atomically during update bursts", async () => {
			await js(`await setState('stack'); __fixture.configure({'watches.list':{delay:100}}); for(let i=0;i<4;i++) applyUpdate({seq:snap.seq+1,type:'budget.updated',missionId:'m1',mission:{...snap.missions.m1}});`);
			await sleep(200);
			assert.equal(await js("return document.querySelectorAll('#stack h6').length;"), 4);
			assert.equal(await js("return document.querySelectorAll('#stack .card').length;"), 5);
		}],
		["question input and unchanged activity retain their DOM state", async () => {
			await js(`__fixture.variant('question'); await setState('mission');`);
			await sleep(450);
			assert.equal(await js(`const input=document.querySelector('#qOpts textarea'); input.value='Final workbook'; input.focus(); const row=document.querySelector('#feed .fl'); applyUpdate({seq:snap.seq+1,type:'budget.updated',missionId:'m1',mission:{...snap.missions.m1}}); return input===document.querySelector('#qOpts textarea') && input.value==='Final workbook' && document.activeElement===input && row===document.querySelector('#feed .fl');`), true);
		}],
		["quick navigation ignores old size and focus callbacks", async () => {
			await js(`__fixture.configure({'ui.size':{delay:200}}); setState('mission'); setState('idle');`);
			await sleep(1000);
			assert.deepEqual(await js("return {state:cur,rendered:cap.dataset.s};"), { state: "idle", rendered: "idle" });
			await js(`__fixture.configure({'ui.size':{delay:0}}); await setState('chat'); await setState('stack');`);
			await sleep(500);
			assert.notEqual(await js("return document.activeElement.id;"), "box");
			assert.equal(await js("return [...document.querySelectorAll('.lay')].filter(l=>!l.classList.contains('l-stack')).every(l=>l.inert && l.getAttribute('aria-hidden')==='true');"), true);
		}],
		["approval acknowledgments require an open card and retry after failure", async () => {
			await js(`__fixture.variant('approval');`);
			await sleep(100);
			assert.equal((await calls("approvals.displayed")).length, 0);
			await js(`__fixture.configure({'approvals.displayed':{queue:[{error:'Temporary failure'},{result:{ok:true}}]},'approvals.decide':{result:{ok:false,error:'Approval expired'}}}); await setState('mission');`);
			await sleep(450);
			if (!(await calls("approvals.displayed")).length) await js("await ensureDisplayed(visibleApproval).catch(showErr);");
			assert.equal((await calls("approvals.decide")).length, 0);
			assert.match(await js("return document.getElementById('errorText').textContent;"), /Temporary failure/);
			await js("document.getElementById('askYes').click();");
			await sleep(100);
			assert.equal((await calls("approvals.displayed")).length, 2);
			assert.match(await js("return document.getElementById('errorText').textContent;"), /Approval expired/);
			assert.equal(await js("return document.getElementById('uiError').hidden;"), false);
		}],
		["late evidence stays attached to its mission", async () => {
			await js(`__fixture.variant('done'); await setState('read'); __fixture.configure({'query.mission':{queue:[{delay:200,result:{evidence:[{kind:'web',source:'https://old.test',capturedAt:new Date().toISOString(),excerpt:'OLD'}]}},{delay:10,result:{evidence:[{kind:'web',source:'https://new.test',capturedAt:new Date().toISOString(),excerpt:'NEW'}]}}]}}); toggleEvidence(); openMission('m2'); await setState('read'); toggleEvidence();`);
			await sleep(300);
			const text = await js("return document.getElementById('evidence').textContent;");
			assert.match(text, /NEW/);
			assert.doesNotMatch(text, /OLD/);
			await js(`await setState('mission'); await setState('read');`);
			assert.equal(await js("return readEvidence || !document.getElementById('evidence').hidden;"), false);
			await js("await toggleEvidence();");
			assert.equal(await js("return document.getElementById('evidence').hidden;"), false);
		}],
		["failed follow-up preserves text and displays the error", async () => {
			await js(`__fixture.variant('done'); await setState('mission'); __fixture.configure({'missions.followUp':{error:'Engine stopped'}}); const r=document.getElementById('reply'); r.value='Unsent follow-up'; r.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
			await sleep(100);
			assert.equal(await js("return document.getElementById('reply').value;"), "Unsent follow-up");
			assert.equal(await js("return document.getElementById('uiError').hidden;"), false);
		}],
		["copy uses the displayed stream and ignores stale runs", async () => {
			await js(`snap.missions.m1.runId='new'; snap.missions.m1.answer='Previous answer'; await setState('mission'); onLive({missionId:'m1',runId:'new',type:'assistant_start'}); onLive({missionId:'m1',runId:'new',type:'text',delta:'New response'}); onLive({missionId:'m1',runId:'old',type:'text',delta:'Stale response'}); document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,shiftKey:true,bubbles:true}));`);
			await sleep(60);
			assert.equal((await calls("clipboard.write")).at(-1).args[0], "New response");
			assert.equal(await js("return document.getElementById('ans').textContent;"), "New response");
		}],
		["different missions start reading at the top", async () => {
			const answer = JSON.stringify(Array.from({ length: 80 }, (_, i) => `Paragraph ${i} with more content`).join("\n\n"));
			await js(`__fixture.variant('done'); snap.missions.m1.answer=${answer}; snap.missions.m2.answer=${answer}; await setState('mission'); renderMission();`);
			await sleep(150);
			await js(`document.getElementById('ans').scrollTop=600; openMission('m2');`);
			await sleep(100);
			assert.equal(await js("return document.getElementById('ans').scrollTop;"), 0);
		}],
		["rule and watch selections match their submitted values", async () => {
			await js("openSettings();");
			await sleep(200);
			await js(`document.querySelector('#sec-rules [aria-label=Action]').click(); [...document.querySelectorAll('.dd-i')].find(b=>b.textContent==='Save files').click(); document.querySelector('#sec-rules [aria-label=Expires] button').click();`);
			assert.match(await js("return document.querySelector('#sec-rules [aria-label=Action]').textContent;"), /Save files/);
			assert.equal(await js("return document.querySelector('#sec-rules [aria-label=Expires] button').getAttribute('aria-checked');"), "true");
			await js(`document.querySelector('#sec-watches [aria-label="Watch name"]').value='Test'; document.querySelector('#sec-watches [aria-label="What to watch"]').value='https://example.invalid'; document.querySelector('#sec-watches [aria-label="How often"] button').click(); document.querySelectorAll('#sec-watches [aria-label="On change"] button')[1].click();`);
			assert.equal(await js("return document.querySelector('#sec-watches [aria-label=\"How often\"] [aria-checked=true]').textContent;"), "30m");
			assert.equal(await js("return document.querySelector('#sec-watches [aria-label=\"On change\"] [aria-checked=true]').textContent;"), "Prepare an update");
			await js(`document.querySelector('#sec-rules [aria-label=Action]').click(); __fixture.emit({kind:'auth-event',event:{type:'info',message:'Background update'}}); document.querySelector('#sec-rules [aria-label=Action]').click();`);
			assert.equal(await js("return document.querySelectorAll('.dd-menu').length;"), 1);
		}],
		["small-screen plans scroll without hiding the header or footer", async () => {
			await js(`document.documentElement.style.setProperty('--h-mission','390px'); __fixture.variant('approval'); await setState('mission');`);
			await sleep(500);
			assert.equal(await js(`const c=cap.getBoundingClientRect(), h=document.querySelector('#l-mission>.mh').getBoundingClientRect(); return h.top>=c.top && h.bottom<c.bottom && cap.scrollTop===0 && document.getElementById('missionBody').scrollHeight>document.getElementById('missionBody').clientHeight;`), true);
		}],
		["Command shortcuts open reading view", async () => {
			await js(`await setState('mission'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'e',metaKey:true,bubbles:true}));`);
			await sleep(50);
			assert.equal(await js("return cur;"), "read");
		}],
	];
	let failures = 0;
	for (const [name, run] of tests) {
		await reset();
		try { await run(); assert.deepEqual(errors, []); console.log(`[ui] PASS ${name}`); }
		catch (err) { failures++; console.log(`[ui] FAIL ${name}: ${err.stack}`); }
	}
	win.destroy();
	console.log(`[ui] ${tests.length - failures}/${tests.length} passed`);
	app.exit(failures ? 1 : 0);
}).catch((err) => { console.error(err); app.exit(1); });
