# PostureLab · Simulador (Flask)

App Flask con escaneo real de postura: presionas "Iniciar escaneo", se
enciende tu cámara 5 segundos, y MediaPipe PoseLandmarker calcula los
ángulos de cuello/torso/hombros directamente sobre tus landmarks 3D (no
importa si estás de frente o de lado). El resultado se pinta sobre el
maniquí real exportado desde Blender durante 10 segundos.

## Estructura

```
posturelab-flask/
├── app.py                     <- servidor Flask (2 rutas: / y /simulador)
├── requirements.txt
├── templates/
│   └── simulador.html         <- plantilla Jinja (botón de escaneo, HUD, preview de cámara)
└── static/
    ├── css/style.css
    ├── js/main.js              <- UI, flujo idle -> loading -> scanning -> hold, maniquí
    ├── js/pose-detector.js     <- cámara + MediaPipe PoseLandmarker + cálculo de ángulos
    └── assets/posturelab_mannequin.glb
```

## Cómo correrlo

```bash
cd posturelab-flask
python -m venv venv
en Windows: venv\Scripts\activate
pip install -r requirements.txt
python3 app.py
```

Abre `http://127.0.0.1:5000` **con HTTPS o en localhost** (el navegador
solo permite `getUserMedia` en esos dos casos; `127.0.0.1`/`localhost`
cuentan como "seguro" aunque no tengan certificado).

## Cómo funciona el escaneo

1. Clic en "Iniciar escaneo" → `pose-detector.js` pide permiso de cámara
   y carga (primera vez) el modelo `pose_landmarker_lite` de MediaPipe
   desde CDN.
2. Durante 5s corre `detectForVideo` en cada frame y guarda una muestra
   de ángulos por frame válido (con hombros/caderas visibles).
3. Al terminar, calcula la mediana de esas muestras y arma un
   diagnóstico: ángulo cervical, inclinación de torso, desnivel de
   hombros, y qué zonas superaron su umbral.
4. `main.js` pinta esas zonas en rojo sobre el maniquí (o todo verde si
   la postura es correcta) durante 10s, y después vuelve a "listo".

Los umbrales (20° cuello, 15° torso, 1.5cm hombros) y la forma de medir
(magnitud del desplazamiento horizontal en 3D respecto a la vertical,
sin importar hacia dónde mira la cámara) están documentados en
`static/js/pose-detector.js` — son un punto de partida razonable, pero
conviene calibrarlos con casos reales antes de usarlos como diagnóstico
serio.

## Próximos pasos (según tu documento)

1. **SQLite para evaluaciones**: agrega un modelo simple (puedes usar
   `sqlite3` directo o Flask-SQLAlchemy) con una tabla `evaluaciones`
   (fecha, ángulo cervical, inclinación de torso, zonas afectadas, ok/bad).
   Al terminar cada escaneo en `main.js` (función `finishScan`), puedes
   hacer un `fetch('/api/evaluacion', {method: 'POST', body: JSON.stringify(diag)})`
   hacia una nueva ruta en `app.py` que inserte esa fila.
2. **Dashboard**: cuando tengas más de una página, mueve el simulador a
   `/simulador` (ya está esa ruta lista) y usa `/` para el dashboard con
   el historial guardado en SQLite.
3. **Calibración**: comparar los ángulos calculados contra mediciones
   reales (foto de perfil + goniómetro, por ejemplo) para ajustar los
   umbrales si hace falta.

## Nota sobre el modelo 3D

Sigue siendo el maniquí procedural "male_primitive_realistic" recortado
de tu bundle, con 6 zonas mapeadas (`head`, `neck`, `shoulderL`,
`shoulderR`, `upperSpine`, `lowerSpine` — ver comentario `ZONE_NODE_NAMES`
en `static/js/main.js`). Esa parte no se tocó: sigue siendo la misma
carga de `.glb`, el mismo mapeo de zonas y el mismo click-to-inspect que
ya funcionaba. Si más adelante separas otras zonas en Blender (ej. zona
lumbar aparte de espalda alta), solo agregas la entrada al mapeo y a la
lógica de diagnóstico en `pose-detector.js`.
