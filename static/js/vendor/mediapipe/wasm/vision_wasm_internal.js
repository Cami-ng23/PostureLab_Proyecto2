<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>PostureLab · Escaneo de postura</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="{{ url_for('static', filename='css/style.css') }}" />
</head>
<body>

  <div class="pl-root">

    <aside class="pl-hud">
      <div class="pl-header">
        <div class="pl-kicker">
          <span class="pl-live-dot"></span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          <span>PostureLab · Escaneo</span>
        </div>
        <h1>Análisis postural</h1>
        <p class="pl-sub">Escaneamos tu postura con la cámara durante 5 segundos. De frente o de lado, da lo mismo.</p>
        <p id="model-error" class="pl-error" hidden>No se pudo cargar el modelo 3D (revisa la ruta de static/assets/posturelab_mannequin.glb).</p>
        <p id="camera-error" class="pl-error" hidden>No pudimos acceder a tu cámara. Revisá los permisos del navegador e intentá de nuevo.</p>
      </div>

      <button id="scan-button" class="pl-scan-btn">Iniciar escaneo</button>

      <div id="status-card" class="pl-card">
        <div class="pl-bar thin pl-card-progress"><div id="progress-bar" class="pl-bar-fill gradient"></div></div>

        <div class="pl-card-top">
          <svg id="status-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"></svg>
          <span id="status-tag" class="pl-tag">En espera</span>
        </div>
        <div id="status-label" class="pl-label">Presioná Iniciar escaneo</div>
        <p id="status-desc" class="pl-desc"></p>

        <div class="pl-metric">
          <div class="pl-metric-row">
            <span id="metric1-name" class="pl-metric-name"></span>
            <span id="metric1-value" class="pl-metric-value mono"></span>
          </div>
          <div class="pl-bar"><div id="metric1-bar" class="pl-bar-fill"></div></div>
        </div>
        <div class="pl-metric">
          <div class="pl-metric-row">
            <span id="metric2-name" class="pl-metric-name"></span>
            <span id="metric2-value" class="pl-metric-value mono"></span>
          </div>
          <div class="pl-bar"><div id="metric2-bar" class="pl-bar-fill"></div></div>
        </div>
        <div class="pl-metric">
          <div class="pl-metric-row">
            <span id="metric3-name" class="pl-metric-name"></span>
            <span id="metric3-value" class="pl-metric-value mono"></span>
          </div>
          <div class="pl-bar"><div id="metric3-bar" class="pl-bar-fill"></div></div>
        </div>
      </div>

      <p class="pl-hint">Toca una zona del modelo para ver sus riesgos.</p>

      <div class="pl-legend">
        <span><i class="dot" style="background:#10b981"></i>Correcto</span>
        <span><i class="dot" style="background:#ef4444"></i>Afectado</span>
        <span><i class="dot" style="background:#475569"></i>Referencia</span>
      </div>

      <div class="pl-history">
        <div class="pl-history-title mono">Historial reciente</div>
        <div id="history-list"></div>
      </div>

      <div class="pl-footer">
        Modelo real: <code>posturelab_mannequin.glb</code> (maniquí "primitive_realistic" recortado del bundle, ~0.42MB).
      </div>
    </aside>

    <main class="pl-canvas-wrap">
      <div id="scan-badge" class="pl-scan-badge mono" hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2" class="pl-spin"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 3v6h-6"/></svg>
        escaneo en progreso · <span id="scan-percent">0%</span>
      </div>
      <div id="scan-sweep" class="pl-scan-sweep" hidden></div>
      <div class="pl-halo-glow" aria-hidden="true"></div>
      <div class="pl-halo-beam" aria-hidden="true"></div>
      <div class="pl-halo-rings" aria-hidden="true">
        <div class="ring"></div>
        <div class="ring"></div>
        <div class="ring"></div>
      </div>
      <canvas id="scene"></canvas>
      <video id="camera-preview" class="pl-camera-preview" autoplay muted playsinline hidden></video>

      <div id="zone-popup" class="pl-zone-popup" hidden>
        <div id="zone-popup-title" class="pl-zone-popup-title"></div>
        <div id="zone-popup-status" class="pl-zone-popup-status mono"></div>
        <p id="zone-popup-risk" class="pl-zone-popup-risk"></p>
      </div>
    </main>

  </div>

  <script type="importmap">
  {
    "imports": {
      "three": "{{ url_for('static', filename='js/vendor/three/build/three.module.js') }}",
      "three/addons/": "{{ url_for('static', filename='js/vendor/three/examples/jsm/') }}"
    }
  }
  </script>
  <script>
    // Flask nos da la URL correcta del asset (con el hash/ruta de static que corresponda)
    window.PL_GLB_URL = "{{ url_for('static', filename='assets/posturelab_mannequin.glb') }}";
  </script>
  <script type="module" src="{{ url_for('static', filename='js/main.js') }}"></script>
</body>
</html>