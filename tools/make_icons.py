"""Gera os ícones da extensão (Ultra Ball em pixel art própria, 16x16) em 16/32/48/128 px.

Uso: python3 tools/make_icons.py
"""
from pathlib import Path
from PIL import Image

GRID = [
    ".....KKKKKK.....",
    "...KKDYDDYDKK...",
    "..KDDYYDDYYDDK..",
    ".KDHDYYDDYYDDDK.",
    ".KHGDYYDDYYDDDK.",
    "KDGDDYYDDYYDDDDK",
    "KDDDDYKKKKYDDDDK",
    "KKKKKKKWWKKKKKKK",
    "KKKKKKKWWKKKKKKK",
    "KWWWWWKKKKWWWWWK",
    "KWHWWWWWWWWWWWLK",
    ".KWWWWWWWWWWWLK.",
    ".KWWWWWWWWWWLLK.",
    "..KLWWWWWWWLLK..",
    "...KKLLLLLLKK...",
    ".....KKKKKK.....",
]
COLORS = {
    ".": (0, 0, 0, 0),
    "K": (24, 24, 28, 255),     # contorno / faixa
    "D": (60, 66, 76, 255),     # cinza escuro do topo
    "G": (110, 118, 130, 255),  # cinza do reflexo
    "H": (236, 240, 248, 255),  # brilho
    "Y": (248, 200, 32, 255),   # faixas amarelas
    "W": (248, 248, 248, 255),  # metade de baixo
    "L": (196, 192, 220, 255),  # sombra lilás
}

assert len(GRID) == 16 and all(len(r) == 16 for r in GRID), "grade precisa ser 16x16"

base = Image.new("RGBA", (16, 16))
for y, row in enumerate(GRID):
    for x, ch in enumerate(row):
        base.putpixel((x, y), COLORS[ch])

out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)
for size in (16, 32, 48, 128):
    base.resize((size, size), Image.NEAREST).save(out / f"icon{size}.png")
print("ícones gerados em", out)
