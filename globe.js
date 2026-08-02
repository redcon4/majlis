/* =====================================================================
   GLOBE.JS — MAJLIS PARTNERS · "GLOBAL REACH" cinematic 3D section
   Fully independent ES module. Does not modify any existing JS/CSS.
   Only reads:   #global-network, #globe-canvas-container, #globe-canvas
   Only writes:  content inside #globe-canvas-container (canvas + labels)

   Everything lives inside a single class (no globals leak — this file
   is loaded as a module, so top-level declarations are module-scoped
   anyway). Three.js is NOT assumed to exist anywhere on the page: it is
   loaded here, at runtime, from a CDN, with automatic fallbacks and
   loud, explicit error reporting if it (or the renderer) fails.
   ===================================================================== */

class GlobeScene {

  constructor() {
    this.section   = document.getElementById('global-network');
    this.container = document.getElementById('globe-canvas-container');
    this.canvas    = document.getElementById('globe-canvas');

    if (!this.canvas || !this.container || !this.section) {
      console.error('Canvas not found');
      return;
    }

    this.COLOR_RED    = 0xff1a36;
    this.COLOR_OUTLINE = 0xe8536a; // rose-wine, palette-matched to the primary red but distinct enough for continent contours
    this.RADIUS     = 1;
    this.ROTATION_SECONDS_PER_TURN = 25;
    this.MAX_TILT_DEG = 3;
    this.PARTICLE_COUNT = 300;

    // Current partnership markets. `iso` = ISO 3166-1 numeric id (matches the
    // world-atlas topojson `id` field) so the country's full shape can be
    // located and filled on the continent-outline texture.
    this.GEOS = [
      { name: 'DE', iso: '276', lat: 51.1,  lng: 10.4  },
      { name: 'PT', iso: '620', lat: 39.5,  lng: -8.0  },
      { name: 'CH', iso: '756', lat: 46.8,  lng: 8.2  },
      { name: 'MA', iso: '504', lat: 31.8,  lng: -7.1  },
      { name: 'DK', iso: '208', lat: 56.2,  lng: 9.5  },
      { name: 'HU', iso: '348', lat: 47.2,  lng: 19.5 },
      { name: 'New Zealand', iso: '554', lat: -41.0, lng: 174.0 }
    ];

    this.markers        = [];
    this.mouseTarget     = { x: 0, y: 0 };
    this.mouseCurrent    = { x: 0, y: 0 };
    this.isVisible       = false;
    this.sequenceStarted = false;
    this.rotationFactor  = 0;   // ramps 0 -> 1 on entrance
    this.coreIntensity   = 0;   // ramps 0 -> 1 on entrance
    this._raf            = null;
    this._destroyed      = false;

    this._onResize    = this.onResize.bind(this);
    this._onMouseMove = this.onMouseMove.bind(this);
    this._animate      = this.animate.bind(this);

    this.init();
  }

  /* ------------------------------------------------------------- *
   *  BOOTSTRAP
   * ------------------------------------------------------------- */
  async init() {
    try {
      this.THREE = await this.loadThree();
    } catch (err) {
      console.error('Three.js not loaded', err);
      return;
    }

    try {
      this.setupRenderer();
    } catch (err) {
      console.error('Renderer failed', err);
      return;
    }

    this.buildScene();
    this.bindEvents();
    this.setupIntersectionObserver();
    this._raf = requestAnimationFrame(this._animate);
  }

  loadThree() {
    const sources = [
      'https://unpkg.com/three@0.165.0/build/three.module.js',
      'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js',
      'https://esm.sh/three@0.165.0'
    ];
    return (async () => {
      let lastError = null;
      for (const url of sources) {
        try {
          const mod = await import(url);
          if (mod && mod.Scene && mod.WebGLRenderer) return mod;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError || new Error('No Three.js source available');
    })();
  }

  /* ------------------------------------------------------------- *
   *  RENDERER / SCENE / CAMERA / LIGHTS
   * ------------------------------------------------------------- */
  setupRenderer() {
    const THREE = this.THREE;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.4);
    this.basePosZ = 4.4;

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.directionalLight.position.set(3, 4, 5);
    this.scene.add(this.directionalLight);

    this.rimLight = new THREE.PointLight(this.COLOR_RED, 2.2, 12, 2);
    this.rimLight.position.set(-2.5, -1.5, 2.5);
    this.scene.add(this.rimLight);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.clock = new THREE.Clock();
  }

  /* ------------------------------------------------------------- *
   *  SCENE CONTENTS
   * ------------------------------------------------------------- */
  buildScene() {
    this.buildGlowTexture();
    this.buildGlassGlobe();
    this.buildGrid();
    this.buildCore();
    this.buildParticles();
    this.buildMarkers();
    this.buildContinents(); // async, fire-and-forget — never blocks the globe from rendering
    this.resize();

    // Start facing the Greenwich meridian (0° longitude) — auto-rotation then
    // carries it rightward (eastward) from there, so partners see every
    // market within one fast revolution.
    this.group.rotation.y = -Math.PI / 2;

    // Entrance state: hidden until the section scrolls into view
    this.group.scale.setScalar(0.001);
    this.glassMaterial.opacity = 0;
  }

  /* ------------------------------------------------------------- *
   *  CONTINENT OUTLINES + PARTNER-COUNTRY FILL
   *  Real country borders, drawn onto an equirectangular canvas and
   *  mapped straight onto the sphere (SphereGeometry's default UVs
   *  are already equirectangular, so no custom UV work is needed).
   *  Fully optional/decorative: if the data can't be fetched, the
   *  globe still renders and works exactly as before.
   * ------------------------------------------------------------- */
  async buildContinents() {
    const THREE = this.THREE;
    let features;
    try {
      const [topojsonMod, topoRes] = await Promise.all([
        import('https://esm.sh/topojson-client@3'),
        fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
      ]);
      if (!topoRes.ok) throw new Error('world-atlas fetch failed: ' + topoRes.status);
      const topoData = await topoRes.json();
      features = topojsonMod.feature(topoData, topoData.objects.countries).features;
    } catch (err) {
      console.warn('[MAJLIS Globe] Continent outline data unavailable — globe still works without it.', err);
      return;
    }
    if (this._destroyed || !features) return;

    const partnerByIso = new Map(this.GEOS.map((g) => [g.iso, g]));

    const W = 2048, H = 1024;
    const project = (lng, lat) => [(lng + 180) / 360 * W, (90 - lat) / 180 * H];

    const strokeRings = (ctx, geometry) => {
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      polygons.forEach((rings) => {
        rings.forEach((ring) => {
          ctx.beginPath();
          ring.forEach(([lng, lat], i) => {
            const [x, y] = project(lng, lat);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.stroke();
        });
      });
    };

    const fillRings = (ctx, geometry) => {
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      polygons.forEach((rings) => {
        ctx.beginPath();
        rings.forEach((ring) => {
          ring.forEach(([lng, lat], i) => {
            const [x, y] = project(lng, lat);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
        });
        ctx.fill('evenodd');
        ctx.stroke();
      });
    };

    // Layer 1 — all continent/country borders, static, rose-wine tint
    const bordersCanvas = document.createElement('canvas');
    bordersCanvas.width = W; bordersCanvas.height = H;
    const bctx = bordersCanvas.getContext('2d');
    bctx.strokeStyle = 'rgba(232, 83, 106, 0.55)';
    bctx.lineWidth = 1.1;
    features.forEach((f) => strokeRings(bctx, f.geometry));

    // Layer 2 — partner countries only, fully filled + brighter border
    const partnersCanvas = document.createElement('canvas');
    partnersCanvas.width = W; partnersCanvas.height = H;
    const pctx = partnersCanvas.getContext('2d');
    pctx.fillStyle = 'rgba(255, 26, 54, 0.55)';
    pctx.strokeStyle = 'rgba(255, 120, 140, 0.9)';
    pctx.lineWidth = 1.6;
    features.forEach((f) => {
      const id = String(f.id);
      if (partnerByIso.has(id)) fillRings(pctx, f.geometry);
    });

    const bordersTexture = new THREE.CanvasTexture(bordersCanvas);
    const partnersTexture = new THREE.CanvasTexture(partnersCanvas);

    this.bordersMaterial = new THREE.MeshBasicMaterial({
      map: bordersTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide
    });
    this.borderSphere = new THREE.Mesh(
      new THREE.SphereGeometry(this.RADIUS * 1.004, 96, 96),
      this.bordersMaterial
    );
    this.group.add(this.borderSphere);

    this.partnersMaterial = new THREE.MeshBasicMaterial({
      map: partnersTexture,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide
    });
    this.partnerSphere = new THREE.Mesh(
      new THREE.SphereGeometry(this.RADIUS * 1.007, 96, 96),
      this.partnersMaterial
    );
    this.group.add(this.partnerSphere);
  }

  buildGlowTexture() {
    const THREE = this.THREE;
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,26,54,0.95)');
    grad.addColorStop(0.4, 'rgba(255,26,54,0.35)');
    grad.addColorStop(1, 'rgba(255,26,54,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    this.glowTexture = new THREE.CanvasTexture(c);
    this.glowTexture.needsUpdate = true;
  }

  buildGlassGlobe() {
    const THREE = this.THREE;
    const geo = new THREE.SphereGeometry(this.RADIUS, 128, 128);
    this.glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0a0610,
      transparent: true,
      opacity: 0.6,
      transmission: 1,
      roughness: 0,
      metalness: 0,
      thickness: 1.5,
      ior: 1.5,
      clearcoat: 0.4,
      clearcoatRoughness: 0.2,
      side: THREE.DoubleSide
    });
    this.glassSphere = new THREE.Mesh(geo, this.glassMaterial);
    this.group.add(this.glassSphere);
  }

  buildGrid() {
    const THREE = this.THREE;
    const gridGroup = new THREE.Group();
    const material = new THREE.LineBasicMaterial({
      color: this.COLOR_RED,
      transparent: true,
      opacity: 0.15
    });
    const r = this.RADIUS * 1.01;

    // latitude rings
    for (let i = 1; i < 6; i++) {
      const lat = (i / 6) * 180 - 90;
      const phi = (90 - lat) * (Math.PI / 180);
      const ringRadius = Math.sin(phi) * r;
      const y = Math.cos(phi) * r;
      const points = [];
      for (let a = 0; a <= 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(t) * ringRadius, y, Math.sin(t) * ringRadius));
      }
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      gridGroup.add(new THREE.Line(geom, material));
    }

    // longitude rings
    for (let i = 0; i < 8; i++) {
      const lng = (i / 8) * 360;
      const theta = lng * (Math.PI / 180);
      const points = [];
      for (let a = 0; a <= 64; a++) {
        const phi = (a / 64) * Math.PI;
        points.push(new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta) * r,
          Math.cos(phi) * r,
          Math.sin(phi) * Math.sin(theta) * r
        ));
      }
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      gridGroup.add(new THREE.Line(geom, material));
    }

    this.gridMaterial = material;
    this.group.add(gridGroup);
  }

  buildCore() {
    const THREE = this.THREE;
    this.coreMaterial = new THREE.MeshStandardMaterial({
      color: this.COLOR_RED,
      emissive: this.COLOR_RED,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.95
    });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 32), this.coreMaterial);
    this.group.add(this.core);

    this.coreHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: this.COLOR_RED,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    this.coreHalo.scale.set(0.7, 0.7, 0.7);
    this.group.add(this.coreHalo);
  }

  buildParticles() {
    const THREE = this.THREE;
    const positions = new Float32Array(this.PARTICLE_COUNT * 3);
    for (let i = 0; i < this.PARTICLE_COUNT; i++) {
      const r = Math.random() * this.RADIUS * 0.9;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.particlesMaterial = new THREE.PointsMaterial({
      color: this.COLOR_RED,
      size: 0.012,
      map: this.glowTexture,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.particles = new THREE.Points(geom, this.particlesMaterial);
    this.group.add(this.particles);
  }

  latLngToVector3(lat, lng, radius) {
    const THREE = this.THREE;
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lng + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
  }

  buildMarkers() {
    const THREE = this.THREE;
    this.markers = this.GEOS.map((geo) => {
      const pos = this.latLngToVector3(geo.lat, geo.lng, this.RADIUS * 1.01);
if (geo.name === 'DE') {
    pos.x += 0.25;
}
      const dotMaterial = new THREE.MeshBasicMaterial({
        color: this.COLOR_RED,
        transparent: true,
        opacity: 0.3
      });
      
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 16), dotMaterial);
      dot.position.copy(pos);
      this.group.add(dot);

      const haloMaterial = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: this.COLOR_RED,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const halo = new THREE.Sprite(haloMaterial);
      halo.scale.set(0.12, 0.12, 0.12);
      halo.position.copy(pos);
      this.group.add(halo);

      const beamGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)
      ]);
      const beamMaterial = new THREE.LineBasicMaterial({
        color: this.COLOR_RED,
        transparent: true,
        opacity: 0
      });
      const beam = new THREE.Line(beamGeo, beamMaterial);
      this.group.add(beam);

      const label = document.createElement('div');
      label.className = 'globe-label' + (geo.lat < 0 ? ' globe-label--above' : '');
      label.textContent = geo.name;
      this.container.appendChild(label);

      return { geo, pos, dot, dotMaterial, halo, haloMaterial, beam, beamMaterial, label, active: false, progress: 0 };
    });
  }

  /* ------------------------------------------------------------- *
   *  EVENTS
   * ------------------------------------------------------------- */
  bindEvents() {
    window.addEventListener('resize', this._onResize);
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(this.container);
    }
    window.addEventListener('mousemove', this._onMouseMove);
  }

  onResize() {
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  onMouseMove(e) {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    const max = this.THREE.MathUtils.degToRad(this.MAX_TILT_DEG);
    this.mouseTarget.y = nx * max;
    this.mouseTarget.x = ny * max;
  }

  /* ------------------------------------------------------------- *
   *  VIEWPORT VISIBILITY — pause / resume rendering
   * ------------------------------------------------------------- */
  setupIntersectionObserver() {
    this.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        this.isVisible = entry.isIntersecting;
        if (this.isVisible) {
          this.startSequence();
          if (!this._raf) this._raf = requestAnimationFrame(this._animate);
        }
      });
    }, { threshold: 0.01 });
    this.observer.observe(this.section);
  }

  /* ------------------------------------------------------------- *
   *  ENTRANCE SEQUENCE
   * ------------------------------------------------------------- */
  startSequence() {
    if (this.sequenceStarted) return;
    this.sequenceStarted = true;

    const gsapAvailable = typeof window.gsap !== 'undefined';

    if (gsapAvailable) {
      const tl = window.gsap.timeline();
      tl.to(this.group.scale, { x: 1, y: 1, z: 1, duration: 1.6, ease: 'power2.out' }, 0);
      tl.to(this.glassMaterial, { opacity: 0.6, duration: 1.6, ease: 'power2.out' }, 0);
      tl.to(this, { coreIntensity: 1, duration: 1.4, ease: 'power2.out' }, 0.2);
      tl.to(this, { rotationFactor: 1, duration: 2.2, ease: 'power2.out' }, 0.3);
      this.markers.forEach((marker, i) => {
        tl.add(() => this.activateMarker(marker), 1.0 + i * 0.9);
      });
    } else {
      const start = performance.now();
      const duration = 1600;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        this.group.scale.setScalar(eased);
        this.glassMaterial.opacity = 0.6 * eased;
        this.coreIntensity = eased;
        this.rotationFactor = eased;
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      this.markers.forEach((marker, i) => {
        setTimeout(() => this.activateMarker(marker), (1.0 + i * 0.9) * 1000);
      });
    }
  }

  activateMarker(marker) {
    const THREE = this.THREE;
    const duration = 800;
    const start = performance.now();
    const step = (now) => {
      if (this._destroyed) return;
      const t = Math.min(1, (now - start) / duration);
      const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0).lerp(marker.pos, t)];
      marker.beam.geometry.setFromPoints(pts);
      marker.beamMaterial.opacity = 0.85 * t;
      marker.dotMaterial.opacity = 0.3 + 0.7 * t;
      marker.haloMaterial.opacity = 0.25 + 0.55 * t;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        marker.active = true;
        marker.beamMaterial.opacity = 0.28;
      }
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------- *
   *  ANIMATION LOOP
   * ------------------------------------------------------------- */
  animate() {
    if (this._destroyed) return;
    this._raf = requestAnimationFrame(this._animate);

    if (!this.isVisible) return; // paused while off-screen

    const THREE = this.THREE;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // Auto rotation — one revolution per ROTATION_SECONDS_PER_TURN, ramps in.
    // It also settles to a near-stop once per lap while Europe (where most
    // of our partner markets sit) is front-and-center, so the labels are
    // actually readable, then speeds back up for the rest of the spin.
    const baseSpeed = (Math.PI * 2) / this.ROTATION_SECONDS_PER_TURN;
    const europeFacingAngle = -Math.PI / 2 - THREE.MathUtils.degToRad(8); // ~8°E, centered on our EU partner cluster
    const twoPi = Math.PI * 2;
    const current = ((this.group.rotation.y % twoPi) + twoPi) % twoPi;
    const target = ((europeFacingAngle % twoPi) + twoPi) % twoPi;
    let diff = Math.abs(current - target);
    if (diff > Math.PI) diff = twoPi - diff;
    const pauseWindow = THREE.MathUtils.degToRad(20);
    const proximityT = THREE.MathUtils.clamp(diff / pauseWindow, 0, 1);
    const settleMultiplier = 0.05 + 0.95 * (proximityT * proximityT * (3 - 2 * proximityT)); // smoothstep ease
    this.group.rotation.y -= baseSpeed * dt * (0.1 + 0.9 * this.rotationFactor) * settleMultiplier;

    // Mouse tilt — eased, max 3°
    this.mouseCurrent.x += (this.mouseTarget.x - this.mouseCurrent.x) * 0.04;
    this.mouseCurrent.y += (this.mouseTarget.y - this.mouseCurrent.y) * 0.04;
    this.group.rotation.x = this.mouseCurrent.x;
    this.group.rotation.z = this.mouseCurrent.y * 0.2;

    // Camera breathing — almost static, tiny movement only
    this.camera.position.z = this.basePosZ + Math.sin(t * 0.35) * 0.06;
    this.camera.position.y = Math.sin(t * 0.22) * 0.03;

    // Core pulse
    const pulse = 0.85 + Math.sin(t * 0.9) * 0.15;
    this.core.scale.setScalar(pulse * (0.6 + 0.4 * this.coreIntensity));
    this.coreMaterial.emissiveIntensity = (0.8 + 0.8 * this.coreIntensity) * pulse;
    this.coreHalo.material.opacity = (0.3 + 0.35 * this.coreIntensity) * pulse;
    this.coreHalo.scale.setScalar(0.6 + Math.sin(t * 0.5) * 0.08);

    // Particle drift
    this.particles.rotation.y += dt * 0.02;
    this.particles.rotation.x += dt * 0.008;

    // Grid shimmer
    this.gridMaterial.opacity = 0.15 + Math.sin(t * 0.2) * 0.03;

    // Partner-country fill — gentle blink across the highlight itself
    const blink = 0.5 + 0.5 * Math.sin(t * 2.2);
    if (this.partnersMaterial) {
      this.partnersMaterial.opacity = 0.35 + 0.45 * blink;
    }

    // Project labels to screen space
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const worldPos = new THREE.Vector3();
    this.markers.forEach((marker) => {
      marker.dot.getWorldPosition(worldPos);
      const normal = worldPos.clone().normalize();
      const toCamera = new THREE.Vector3().subVectors(this.camera.position, worldPos).normalize();
      const facing = normal.dot(toCamera);

      const screen = worldPos.clone().project(this.camera);
      const x = (screen.x * 0.5 + 0.5) * w;
      const y = (-screen.y * 0.5 + 0.5) * h;
      const belowOffset = marker.geo.lat < 0 ? '-26px' : '14px';
      marker.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${belowOffset})`;

      const fade = THREE.MathUtils.clamp((facing - 0.12) / 0.3, 0, 1);
      const opacity = marker.active ? fade : 0;
      marker.label.style.opacity = String(opacity);
    });

    this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------- *
   *  CLEANUP
   * ------------------------------------------------------------- */
  destroy() {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('mousemove', this._onMouseMove);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.observer) this.observer.disconnect();
    this.markers.forEach((m) => m.label.remove());
    if (this.renderer) this.renderer.dispose();
  }
}

new GlobeScene();