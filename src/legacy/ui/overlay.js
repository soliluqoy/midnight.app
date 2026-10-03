const cur = document.getElementById("cur"), ring = document.getElementById("ring"), frame = document.getElementById("frame");
let hideT;
const W = () => innerWidth, H = () => innerHeight;
function showFrame(x, y, w, h, label) {
  Object.assign(frame.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px", opacity: 1 });
  document.getElementById("fl").textContent = label;
}
midnight.onOverlay((m) => {
  clearTimeout(hideT);
  if (m.type === "off") { cur.style.opacity = 0; frame.style.opacity = 0; return; }
  if (m.type !== "act") return;
  if (m.x !== undefined) {
    cur.style.opacity = 1;
    cur.style.transform = `translate(${m.x - 3}px, ${m.y - 2}px)`;
    ring.style.left = m.x + "px"; ring.style.top = m.y + "px";
    if (/click/.test(m.action)) setTimeout(() => { ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go"); }, 500);
    if (m.action === "drag") showFrame(Math.min(m.x, m.x2), Math.min(m.y, m.y2), Math.abs(m.x2 - m.x), Math.abs(m.y2 - m.y), "drag");
    else showFrame(m.x - 90, m.y - 60, 180, 120, m.action);
  } else if (m.action === "screenshot") {
    showFrame(8, 8, W() - 16, H() - 16, "looking · screen");
  } else {
    showFrame(W() / 2 - 160, H() / 2 - 40, 320, 80, m.action);
  }
  hideT = setTimeout(() => { frame.style.opacity = 0; }, 2200);
});
