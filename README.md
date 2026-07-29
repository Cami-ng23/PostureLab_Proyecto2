# PostureLab · Simulador (Flask)

Mismo simulador de antes, ahora integrado a una app Flask real en lugar
de HTML plano. Sin build step: Flask sirve la plantilla y los estáticos,
y Three.js sigue viniendo por CDN.

## Estructura

```
posturelab-flask/
├── app.py                     <- servidor Flask (2 rutas: / y /simulador)
├── requirements.txt
├── templates/
│   └── simulador.html         <- plantilla Jinja (antes index.html)
└── static/
    ├── css/style.css
    ├── js/main.js              <- misma lógica de antes (ciclo, colores, carga del modelo)
    └── assets/posturelab_mannequin.glb
```

## Cómo correrlo

```bash
cd posturelab-flask
python3 -m venv venv
source venv/bin/activate        # en Windows: venv\Scripts\activate
pip install -r requirements.txt
python3 app.py
```

Abre `http://127.0.0.1:5000`.

## Qué cambió respecto a la versión standalone

- `js/main.js`: la carga del `.glb` ahora usa `window.PL_GLB_URL`, que
  `simulador.html` llena con `{{ url_for('static', filename=...) }}`.
  Así el archivo se sirve siempre desde la ruta correcta de Flask, sin
  importar si algún día montas la app bajo un subpath o cambias de
  estructura de carpetas.
- CSS y JS pasaron a `static/`, la plantilla a `templates/` — es la
  convención estándar de Flask, para que cuando agregues más páginas
  (login, dashboard, historial de evaluaciones) todo viva en el mismo
  esquema.

## Próximos pasos (según tu documento)

1. **SQLite para evaluaciones**: agrega un modelo simple (puedes usar
   `sqlite3` directo o Flask-SQLAlchemy) con una tabla `evaluaciones`
   (fecha, ángulo cervical, inclinación de torso, zonas afectadas, ok/bad).
   Cuando el ciclo cambie de estado en `main.js`, puedes hacer un
   `fetch('/api/evaluacion', {method: 'POST', body: JSON.stringify(s)})`
   hacia una nueva ruta en `app.py` que inserte esa fila.
2. **Cámara real + MediaPipe**: reemplaza el `setInterval` de `main.js`
   por los ángulos calculados en vivo desde los landmarks — el resto del
   pipeline (colores, pose del maniquí, HUD) no cambia.
3. **Dashboard**: cuando tengas más de una página, mueve el simulador a
   `/simulador` (ya está esa ruta lista) y usa `/` para el dashboard con
   el historial guardado en SQLite.

## Nota sobre el modelo 3D

Sigue siendo el maniquí procedural "male_primitive_realistic" recortado
de tu bundle, con 6 zonas mapeadas (`head`, `neck`, `shoulderL`,
`shoulderR`, `upperSpine`, `lowerSpine` — ver comentario `ZONE_NODE_NAMES`
en `static/js/main.js`). Si más adelante separas otras zonas en Blender
(ej. zona lumbar aparte de espalda alta), solo agregas la entrada al
mapeo y un estado nuevo en `STATES`.
