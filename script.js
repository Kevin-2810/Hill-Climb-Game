
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const W = 800, H = 480;
let canvasScaleX = 1, canvasScaleY = 1;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  canvasScaleX = canvas.width / W;
  canvasScaleY = canvas.height / H;
  ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

// ── Vehicle configs  (power/maxVx tuned for realistic feel) ──────────────────
// power   = acceleration per frame on ground
// maxVx   = hard speed cap (pixels/frame)
// wheelR  = visual + physics wheel radius
// coinHitR= coin collection radius (accounts for vehicle size)
const VEHICLES = {
  jeep:  { w:84,  h:36, color:'#e85d04', wheelR:16, power:0.22, maxVx:7.5,  mass:1.2, fuelRate:0.09,  grip:0.97, coinHitR:50 },
  truck: { w:104, h:44, color:'#1d4ed8', wheelR:20, power:0.18, maxVx:6.0,  mass:1.9, fuelRate:0.13,  grip:0.98, coinHitR:60 },
  bike:  { w:64,  h:28, color:'#7c3aed', wheelR:14, power:0.26, maxVx:9.0,  mass:0.8, fuelRate:0.055, grip:0.93, coinHitR:40 },
  buggy: { w:80,  h:30, color:'#f59e0b', wheelR:15, power:0.30, maxVx:10.5, mass:1.0, fuelRate:0.10,  grip:0.91, coinHitR:48 },
  tank:  { w:96,  h:40, color:'#4d7c0f', wheelR:19, power:0.16, maxVx:5.5,  mass:2.2, fuelRate:0.14,  grip:0.99, coinHitR:58 },
  bus:   { w:120, h:50, color:'#dc2626', wheelR:18, power:0.13, maxVx:5.0,  mass:2.5, fuelRate:0.16,  grip:0.98, coinHitR:68 },
};

const DIFFICULTY = {
  easy:   { hillAmp:55,  fuelMult:0.65, coinVal:14 },
  medium: { hillAmp:85,  fuelMult:1.0,  coinVal:9  },
  hard:   { hillAmp:125, fuelMult:1.4,  coinVal:5  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let gameState = 'menu';
let selectedVehicle = 'jeep';
let selectedDiff = 'easy';
let keys = {};
let gasDown = false, brakeDown = false;
let bestDist = 0;
let terrain, cam, car, coins, particles;
let fuel, dist, speed, maxSpeed, elapsedTime, startTime, animId, lastT, coinCount;
let flipTimer = 0;          // seconds vehicle has been flipped past 90°
const FLIP_KILL_TIME = 1.5; // seconds until game over after flip

// ── Input ─────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  keys[e.key] = true;
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)) e.preventDefault();
});
document.addEventListener('keyup', e => { keys[e.key] = false; });

['btn-gas','btn-brake'].forEach(id => {
  const el = document.getElementById(id);
  const isGas = id === 'btn-gas';
  el.addEventListener('touchstart', e => { e.preventDefault(); isGas ? gasDown=true : brakeDown=true; }, {passive:false});
  el.addEventListener('touchend',   () => { isGas ? gasDown=false : brakeDown=false; });
  el.addEventListener('mousedown',  () => { isGas ? gasDown=true  : brakeDown=true; });
  document.addEventListener('mouseup', () => { gasDown=false; brakeDown=false; });
});

// Vehicle cards — single-select, update selectedVehicle
document.querySelectorAll('.v-card').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.v-card').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    selectedVehicle = el.dataset.v;
  });
});

document.querySelectorAll('.diff-btn').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    selectedDiff = el.dataset.d;
  });
});

// ── Terrain ───────────────────────────────────────────────────────────────────
function genTerrain(startX, count) {
  const amp = DIFFICULTY[selectedDiff].hillAmp;
  const pts = [];
  let x = startX, y = 280;
  for (let i = 0; i < count; i++) {
    pts.push({x, y});
    x += 55 + Math.random() * 70;
    y = Math.max(180, Math.min(400, y + (Math.random() - 0.48) * amp));
  }
  return pts;
}

function getTerrainY(wx) {
  for (let i = 0; i < terrain.length - 1; i++) {
    const a = terrain[i], b = terrain[i+1];
    if (wx >= a.x && wx <= b.x) {
      return a.y + (wx - a.x) / (b.x - a.x) * (b.y - a.y);
    }
  }
  return terrain[terrain.length-1].y;
}

function getTerrainAngle(wx) {
  for (let i = 0; i < terrain.length - 1; i++) {
    const a = terrain[i], b = terrain[i+1];
    if (wx >= a.x && wx <= b.x) return Math.atan2(b.y - a.y, b.x - a.x);
  }
  return 0;
}

// ── Start / End ───────────────────────────────────────────────────────────────
function startGame() {
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('stats-row').style.display = 'none';
  gameState = 'playing';

  terrain = genTerrain(0, 250);
  cam = { x: 0 };
  flipTimer = 0;

  // Build car from the SELECTED vehicle config — this is the single source of truth
  const vc = VEHICLES[selectedVehicle];
  car = {
    x: 140, y: 250,
    vx: 0, vy: 0,
    angle: 0, angVel: 0,
    onGround: false,
    wheelSpin: 0,
    // copy all vehicle properties directly into car
    w: vc.w, h: vc.h, color: vc.color,
    wheelR: vc.wheelR, power: vc.power, maxVx: vc.maxVx,
    mass: vc.mass, fuelRate: vc.fuelRate, grip: vc.grip,
    coinHitR: vc.coinHitR,
    type: selectedVehicle
  };

  coins = []; particles = [];
  spawnCoins(280, 80);
  fuel = 100; dist = 0; speed = 0; maxSpeed = 0; elapsedTime = 0; coinCount = 0;
  startTime = performance.now(); lastT = null;

  if (animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(loop);
}

function spawnCoins(startX, count) {
  for (let i = 0; i < count; i++) {
    const tx = startX + i * 150 + Math.random() * 60;
    // Place coin at terrain surface level (not far above) — fix collection issues
    const ty = getTerrainY(tx) - 30;
    coins.push({ x: tx, y: ty, collected: false, bob: Math.random() * Math.PI * 2 });
  }
}

function endGame(reason) {
  if (gameState !== 'playing') return;
  gameState = 'over';

  if (dist > bestDist) {
    bestDist = dist;
    document.getElementById('best-badge').style.display = 'block';
    document.getElementById('best-val').textContent = Math.round(bestDist) + 'm';
  }
  document.getElementById('e-dist').textContent  = Math.round(dist) + 'm';
  document.getElementById('e-coins').textContent = coinCount;
  document.getElementById('e-time').textContent  = Math.round(elapsedTime) + 's';
  document.getElementById('e-spd').textContent   = Math.round(maxSpeed) + ' km/h';
  document.getElementById('stats-row').style.display = 'flex';

  const titles = { fuel:'⛽ Out of Fuel!', flip:'🔄 Flipped Over!', fall:'💥 Fell Off!' };
  const subs   = { fuel:'Next time collect more coins!', flip:'Stay upright on those hills!', fall:'Watch those big drops!' };
  document.getElementById('overlay-title').textContent = titles[reason] || '💥 Game Over!';
  document.getElementById('overlay-sub').textContent   = dist >= bestDist ? '🏆 New personal best!' : (subs[reason] || 'Try again!');
  document.getElementById('start-btn').textContent = '🔄 Play Again';
  document.getElementById('overlay').style.display = 'flex';
  document.getElementById('flip-warn').style.opacity = '0';
  document.getElementById('warn').style.opacity = '0';
}

// ── Particles ─────────────────────────────────────────────────────────────────
function spawnParticle(sx, sy, type) {
  // sx/sy are SCREEN coordinates (already offset by cam)
  for (let i = 0; i < (type === 'coin' ? 7 : 3); i++) {
    const a = Math.random() * Math.PI * 2, spd = 1 + Math.random() * 3;
    particles.push({
      x: sx, y: sy,
      vx: Math.cos(a)*spd, vy: Math.sin(a)*spd - 2,
      life: 1, decay: 0.03 + Math.random()*0.04,
      r: type === 'coin' ? 5 : 3,
      color: type === 'coin' ? '#fbbf24' : '#a16207',
      isScreen: true
    });
  }
}

function spawnDust(worldX, worldY) {
  particles.push({
    x: worldX + (Math.random()-0.5)*8, y: worldY,
    vx: (Math.random()-0.5)*1.5, vy: -Math.random()*1.5,
    life: 1, decay: 0.06 + Math.random()*0.04,
    r: 3 + Math.random()*4, color: '#a16207', isScreen: false
  });
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function loop(t) {
  animId = requestAnimationFrame(loop);
  const dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 0.016;
  lastT = t;
  if (gameState === 'playing') { update(dt, t); draw(t); }
}

function update(dt, t) {
  elapsedTime = (performance.now() - startTime) / 1000;
  const gas   = keys['ArrowRight'] || keys['d'] || keys['D'] || gasDown;
  const brake = keys['ArrowLeft']  || keys['a'] || keys['A'] || brakeDown;
  const diff  = DIFFICULTY[selectedDiff];

  const tAngle = getTerrainAngle(car.x);
  const ty     = getTerrainY(car.x);
  const onGnd  = car.y >= ty - car.wheelR - 1;
  car.onGround = onGnd;

  if (onGnd) {
    car.y      = ty - car.wheelR;
    car.vy     = 0;
    car.angVel = 0;
    // Smoothly rotate car to terrain slope
    car.angle += (tAngle - car.angle) * 0.3;

    if (gas && fuel > 0) {
      // Accelerate along slope, capped at maxVx
      car.vx = Math.min(car.maxVx, car.vx + Math.cos(tAngle) * car.power);
      fuel  -= car.fuelRate * diff.fuelMult;
      car.wheelSpin += 0.5;
      if (Math.random() < 0.35) spawnDust(car.x - car.w/2 + car.wheelR, ty);
    }
    if (brake) {
      car.vx = Math.max(0, car.vx - 0.55);
    }
    // Friction
    car.vx *= car.grip;
  } else {
    // Air physics
    car.vy += 9.8 * dt * 36;
    car.vx *= 0.998;
    if (gas && fuel > 0) {
      car.vx = Math.min(car.maxVx, car.vx + car.power * 0.3);
      car.angVel += 0.018;
      fuel -= car.fuelRate * 0.35 * diff.fuelMult;
      car.wheelSpin += 0.5;
    }
    car.angle += car.angVel * dt * 60;
  }

  if (car.vx < 0) car.vx = 0;
  car.x += car.vx;
  car.y += car.vy * dt;

  fuel     = Math.max(0, Math.min(100, fuel));
  speed    = car.vx * 13;
  maxSpeed = Math.max(maxSpeed, speed);
  dist     = Math.max(dist, car.x - 140);
  cam.x   += (car.x - W * 0.38 - cam.x) * 0.1;

  // ── Flip detection ─────────────────────────────────────────────────────────
  // Normalise angle to [-PI, PI]
  let normAngle = ((car.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (normAngle > Math.PI) normAngle -= Math.PI * 2;
  const isFlipped = Math.abs(normAngle) > Math.PI * 0.65; // >117° = flipped

  if (isFlipped && !car.onGround) {
    flipTimer += dt;
    document.getElementById('flip-warn').style.opacity = '1';
    // Show countdown in warning
    const remaining = Math.max(0, FLIP_KILL_TIME - flipTimer).toFixed(1);
    document.getElementById('flip-warn').textContent = `🔄 Flipping! Game over in ${remaining}s`;
  } else if (isFlipped && car.onGround) {
    // Landed fully inverted on ground → instant game over
    flipTimer = FLIP_KILL_TIME;
  } else {
    flipTimer = Math.max(0, flipTimer - dt * 2); // recover if righted
    if (flipTimer === 0) document.getElementById('flip-warn').style.opacity = '0';
  }
  if (flipTimer >= FLIP_KILL_TIME) { endGame('flip'); return; }

  // ── Coin collection ────────────────────────────────────────────────────────
  // Use car center (x, y - h/2) and a generous hitbox = coinHitR
  const carCenterX = car.x;
  const carCenterY = car.y - car.h / 2;
  coins.forEach(c => {
    if (c.collected) return;
    const dx = c.x - carCenterX;
    const dy = c.y - carCenterY;
    if (Math.sqrt(dx*dx + dy*dy) < car.coinHitR) {
      c.collected = true;
      coinCount++;
      fuel = Math.min(100, fuel + diff.coinVal);
      // Spawn particle at screen position
      spawnParticle(c.x - cam.x, c.y, 'coin');
    }
  });

  // Particles
  particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= p.decay; });
  particles = particles.filter(p => p.life > 0);

  // Extend terrain + coins
  const lastPt = terrain[terrain.length - 1];
  if (lastPt.x < cam.x + W + 600) {
    const newPts = genTerrain(lastPt.x, 30);
    terrain.push(...newPts.slice(1));
    spawnCoins(lastPt.x + 80, 18);
  }
  while (terrain.length > 2 && terrain[1].x < cam.x - 300) terrain.shift();

  // UI warnings
  document.getElementById('warn').style.opacity = fuel < 20
    ? String(0.6 + 0.4 * Math.sin(t / 180)) : '0';

  // End conditions
  if (fuel <= 0)     { endGame('fuel'); return; }
  if (car.y > H + 80){ endGame('fall'); return; }

  updateHUD();
}

function updateHUD() {
  document.getElementById('h-dist').textContent  = Math.round(dist) + ' m';
  document.getElementById('h-spd').textContent   = Math.round(speed) + ' km/h';
  document.getElementById('h-coins').textContent = coinCount;
  document.getElementById('h-time').textContent  = Math.round(elapsedTime) + 's';
  const ff = document.getElementById('fuel-fill');
  ff.style.width = fuel + '%';
  ff.style.background = fuel > 30
    ? 'linear-gradient(90deg,#22c55e,#86efac)'
    : 'linear-gradient(90deg,#ef4444,#fca5a5)';
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function draw(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
  drawSky(t);
  drawBackgroundMountains();
  drawDistMarkers();
  drawCoins(t);
  drawTerrain();
  drawParticles();
  drawCar();
  drawSpeedLines();
  drawVignette();
}

function drawSky(t) {
  const dayFrac = ((t / 1000) % 60) / 60;
  let c1, c2;
  if (dayFrac < 0.5) {
    c1 = lerpColor('#1e3a5f','#87ceeb', dayFrac*2);
    c2 = lerpColor('#0a1628','#c8e6ff', dayFrac*2);
  } else {
    c1 = lerpColor('#87ceeb','#ff7043', (dayFrac-0.5)*2);
    c2 = lerpColor('#c8e6ff','#4a148c', (dayFrac-0.5)*2);
  }
  const grd = ctx.createLinearGradient(0,0,0,H);
  grd.addColorStop(0,c1); grd.addColorStop(1,c2);
  ctx.fillStyle = grd; ctx.fillRect(0,0,W,H);

  ctx.save();
  if (dayFrac < 0.5) { ctx.shadowColor='#fde68a'; ctx.shadowBlur=30; ctx.fillStyle='#fde68a'; }
  else               { ctx.shadowColor='#e2e8f0'; ctx.shadowBlur=20; ctx.fillStyle='#e2e8f0'; }
  ctx.beginPath();
  ctx.arc(W-100 + Math.sin(t/8000)*30, 70 + Math.cos(t/8000)*20, dayFrac<0.5?26:18, 0, Math.PI*2);
  ctx.fill(); ctx.restore();

  if (dayFrac > 0.45) {
    ctx.save(); ctx.globalAlpha = Math.min(1,(dayFrac-0.45)*8)*0.7; ctx.fillStyle='#fff';
    for (let i=0;i<40;i++) { ctx.beginPath(); ctx.arc((i*173+50)%W,(i*97+20)%(H*0.5),0.5+(i%3)*0.5,0,Math.PI*2); ctx.fill(); }
    ctx.restore();
  }
  drawClouds(t, dayFrac);
}

function drawClouds(t, dayFrac) {
  [{baseX:80,y:65,s:0.9,spd:0.15},{baseX:300,y:50,s:1.1,spd:0.10},{baseX:550,y:75,s:0.75,spd:0.18},{baseX:700,y:55,s:1.0,spd:0.12}]
  .forEach(cp => {
    const x = ((cp.baseX - cam.x*cp.spd)%(W+200)+W+200)%(W+200)-100;
    ctx.save(); ctx.globalAlpha = dayFrac>0.45?0.4:0.75; ctx.fillStyle='#fff';
    [[0,0,32],[30,6,25],[56,0,30],[-26,8,22],[80,4,20]].forEach(([dx,dy,r]) => {
      ctx.beginPath(); ctx.arc(x+dx*cp.s,cp.y+dy*cp.s,r*cp.s,0,Math.PI*2); ctx.fill();
    }); ctx.restore();
  });
}

function drawBackgroundMountains() {
  ctx.save(); ctx.globalAlpha=0.18; ctx.fillStyle='#334155';
  ctx.beginPath(); ctx.moveTo(0,H);
  for (let i=0;i<=12;i++) {
    const mx=(i/12)*W;
    ctx.lineTo(mx, 200+Math.sin(mx/120+cam.x*0.002)*80+Math.sin(mx/60+cam.x*0.003)*40);
  }
  ctx.lineTo(W,H); ctx.fill(); ctx.restore();
}

function drawTerrain() {
  const ox = -cam.x;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(0,H);
  let first=true;
  for (const pt of terrain) {
    const sx=pt.x+ox;
    if (sx<-80||sx>W+80) continue;
    first ? (ctx.lineTo(sx,pt.y),first=false) : ctx.lineTo(sx,pt.y);
  }
  ctx.lineTo(W,H);
  const g=ctx.createLinearGradient(0,180,0,H);
  g.addColorStop(0,'#78350f'); g.addColorStop(0.2,'#92400e'); g.addColorStop(1,'#3d1f0a');
  ctx.fillStyle=g; ctx.fill();
  ctx.beginPath(); first=true;
  for (const pt of terrain) {
    const sx=pt.x+ox;
    if (sx<-80||sx>W+80) continue;
    first ? (ctx.moveTo(sx,pt.y),first=false) : ctx.lineTo(sx,pt.y);
  }
  ctx.strokeStyle='#16a34a'; ctx.lineWidth=7; ctx.lineJoin='round'; ctx.stroke();
  ctx.strokeStyle='#4ade80'; ctx.lineWidth=3; ctx.stroke();
  ctx.restore();
}

function drawDistMarkers() {
  const ox=-cam.x;
  for (let m=0;m<=99999;m+=200) {
    const sx=m+140+ox;
    if (sx<-60||sx>W+60) continue;
    const ty=getTerrainY(m+140)-22;
    ctx.save();
    ctx.fillStyle='rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.roundRect(sx-22,ty-16,44,16,4); ctx.fill();
    ctx.fillStyle='#e5e7eb'; ctx.font='10px sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(m+'m',sx,ty-8); ctx.restore();
  }
}

function drawCoins(t) {
  const ox=-cam.x;
  coins.forEach(c => {
    if (c.collected) return;
    const sx=c.x+ox;
    if (sx<-20||sx>W+20) return;
    const bob=Math.sin(t/500+c.bob)*5;
    ctx.save(); ctx.translate(sx,c.y+bob);
    ctx.shadowColor='#fbbf24'; ctx.shadowBlur=12;
    ctx.beginPath(); ctx.arc(0,0,11,0,Math.PI*2); ctx.fillStyle='#fbbf24'; ctx.fill();
    ctx.strokeStyle='#f59e0b'; ctx.lineWidth=2; ctx.stroke(); ctx.shadowBlur=0;
    ctx.fillStyle='#92400e'; ctx.font='bold 10px sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('$',0,0);
    ctx.restore();
  });
}

function drawParticles() {
  const ox = -cam.x;
  particles.forEach(p => {
    ctx.save();
    ctx.globalAlpha = Math.max(0,p.life);
    ctx.fillStyle = p.color;
    // isScreen particles already have screen coords; world particles need cam offset
    const sx = p.isScreen ? p.x : p.x + ox;
    ctx.beginPath(); ctx.arc(sx, p.y, p.r*p.life, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  });
}

// drawCar now reads exclusively from `car` object (which was built from selectedVehicle at startGame)
function drawCar() {
  const ox = -cam.x;
  const sx = car.x + ox;
  const { w:cw, h:ch, wheelR:wr, color, type } = car;

  ctx.save();
  ctx.translate(sx, car.y);
  ctx.rotate(car.angle);

  // Ground shadow
  ctx.save(); ctx.globalAlpha=0.28; ctx.fillStyle='#000';
  ctx.beginPath(); ctx.ellipse(0,wr+2,cw*0.5,6,0,0,Math.PI*2); ctx.fill(); ctx.restore();

  // Body
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(-cw/2,-ch,cw,ch,[6,6,4,4]); ctx.fill();
  // Highlight
  ctx.fillStyle = lighten(color,30);
  ctx.beginPath(); ctx.roundRect(-cw/2+4,-ch+4,cw-8,ch/3,3); ctx.fill();

  // Cabin / top detail
  if (type !== 'bike') {
    const cabW=cw*0.55, cabH=18;
    ctx.fillStyle=lighten(color,22);
    ctx.beginPath(); ctx.roundRect(-cabW/2,-ch-cabH,cabW,cabH,[6,6,0,0]); ctx.fill();
    ctx.fillStyle='rgba(147,210,255,0.65)';
    ctx.beginPath(); ctx.roundRect(-cabW/2+4,-ch-cabH+4,cabW-8,cabH-6,3); ctx.fill();
  } else {
    ctx.fillStyle='#1f2937';
    ctx.beginPath(); ctx.roundRect(-8,-ch-10,16,8,4); ctx.fill();
    ctx.fillStyle='#374151';
    ctx.beginPath(); ctx.rect(-14,-ch-14,4,10); ctx.fill();
  }

  // Exhaust smoke when using gas on ground
  const gas = keys['ArrowRight']||keys['d']||keys['D']||gasDown;
  if (gas && car.onGround && fuel > 0) {
    ctx.save(); ctx.globalAlpha=0.32; ctx.fillStyle='#9ca3af';
    for (let i=0;i<3;i++) { ctx.beginPath(); ctx.arc(-cw/2-8-i*9,-4+i*2,4+i*3,0,Math.PI*2); ctx.fill(); }
    ctx.restore();
  }

  // Wheels
  const wheelPos = type==='bike'
    ? [[-cw/2+wr+2,0],[cw/2-wr-2,0]]
    : [[-cw/2+wr+5,0],[cw/2-wr-5,0]];
  car.wheelSpin = (car.wheelSpin||0) + car.vx*0.08;

  wheelPos.forEach(([wx,wy]) => {
    ctx.save(); ctx.translate(wx,wy); ctx.rotate(car.wheelSpin);
    ctx.beginPath(); ctx.arc(0,0,wr,0,Math.PI*2); ctx.fillStyle='#111827'; ctx.fill();
    ctx.strokeStyle='#374151'; ctx.lineWidth=2; ctx.stroke();
    ctx.beginPath(); ctx.arc(0,0,wr*0.58,0,Math.PI*2); ctx.fillStyle='#9ca3af'; ctx.fill();
    ctx.strokeStyle='#6b7280'; ctx.lineWidth=1.5;
    for (let s=0;s<5;s++) {
      const a=(s/5)*Math.PI*2;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*wr*0.55,Math.sin(a)*wr*0.55); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0,0,4,0,Math.PI*2); ctx.fillStyle='#e5e7eb'; ctx.fill();
    ctx.restore();
  });

  ctx.restore();
}

function drawSpeedLines() {
  if (speed < 60) return;
  ctx.save();
  ctx.globalAlpha = Math.min(0.22,(speed-60)/280);
  ctx.strokeStyle='#fff'; ctx.lineWidth=1;
  for (let i=0;i<10;i++) {
    const lx=Math.random()*W*0.42, ly=Math.random()*H, len=30+Math.random()*60;
    ctx.beginPath(); ctx.moveTo(lx,ly); ctx.lineTo(lx+len,ly+(Math.random()-0.5)*4); ctx.stroke();
  }
  ctx.restore();
}

function drawVignette() {
  const grd=ctx.createRadialGradient(W/2,H/2,H*0.3,W/2,H/2,H*0.9);
  grd.addColorStop(0,'rgba(0,0,0,0)'); grd.addColorStop(1,'rgba(0,0,0,0.35)');
  ctx.fillStyle=grd; ctx.fillRect(0,0,W,H);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function lighten(hex,amt) {
  let r=parseInt(hex.slice(1,3),16)+amt, g=parseInt(hex.slice(3,5),16)+amt, b=parseInt(hex.slice(5,7),16)+amt;
  return '#'+[Math.min(255,r),Math.min(255,g),Math.min(255,b)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function lerpColor(a,b,t) {
  const pa=parseInt(a.slice(1),16),pb=parseInt(b.slice(1),16);
  const lerp=(c1,c2)=>Math.round(c1+(c2-c1)*t);
  const r=lerp((pa>>16)&0xff,(pb>>16)&0xff);
  const g=lerp((pa>>8)&0xff,(pb>>8)&0xff);
  const bv=lerp(pa&0xff,pb&0xff);
  return '#'+[r,g,bv].map(x=>x.toString(16).padStart(2,'0')).join('');
}

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r) {
    if (typeof r==='number') r=[r,r,r,r];
    const [tl,tr,br,bl]=[...r,...r].slice(0,4);
    this.moveTo(x+tl,y); this.lineTo(x+w-tr,y); this.quadraticCurveTo(x+w,y,x+w,y+tr);
    this.lineTo(x+w,y+h-br); this.quadraticCurveTo(x+w,y+h,x+w-br,y+h);
    this.lineTo(x+bl,y+h); this.quadraticCurveTo(x,y+h,x,y+h-bl);
    this.lineTo(x,y+tl); this.quadraticCurveTo(x,y,x+tl,y);
  };
}

// ── Initial menu background draw ──────────────────────────────────────────────
(function() {
  selectedDiff = 'easy';
  resizeCanvas();
  ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
  const t0 = genTerrain(0, 30);
  ctx.clearRect(0,0,W,H);
  const grd=ctx.createLinearGradient(0,0,0,H);
  grd.addColorStop(0,'#1e3a5f'); grd.addColorStop(1,'#0a1628');
  ctx.fillStyle=grd; ctx.fillRect(0,0,W,H);
  ctx.beginPath(); ctx.moveTo(0,H); t0.forEach(p=>ctx.lineTo(p.x,p.y)); ctx.lineTo(W,H);
  const tg=ctx.createLinearGradient(0,180,0,H);
  tg.addColorStop(0,'#78350f'); tg.addColorStop(1,'#3d1f0a');
  ctx.fillStyle=tg; ctx.fill();
  ctx.beginPath(); t0.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
  ctx.strokeStyle='#16a34a'; ctx.lineWidth=7; ctx.stroke();
  ctx.strokeStyle='#4ade80'; ctx.lineWidth=3; ctx.stroke();
})();
