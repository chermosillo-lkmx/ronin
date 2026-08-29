# Icono de la aplicación

`icon.icns` se genera desde `icon.svg`, que compone dos cosas:

- **Obra base**: "Samurai", publicada por OpenClipart en freesvg.org (SVG id 157759).
  <https://freesvg.org/samurai> — **CC0 / dominio público**. No exige atribución; esta nota
  es por trazabilidad, no por obligación legal.
- **Composición propia**: fondo redondeado `#161826` (--color-bg), borde `#9184d9`
  (--color-accent) y la silueta aplanada a `#d2cefd` (--color-accent-300).
  La obra original usa varios grises de tinta (#060606…#8f8f8f) que a 32 px se emborronan:
  se aplanan a un solo color para que la silueta lea a tamaño de Dock.

## Regenerar

    qlmanage -t -s 1024 -o . icon.svg
    # sips a 16/32/64/128/256/512/1024 dentro de un icon.iconset, y:
    iconutil -c icns icon.iconset -o icon.icns
