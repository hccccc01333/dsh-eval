"""Generate the PNG previews embedded in the README files.

Run from anywhere:
    python scripts/generate_docs_images.py

The images are intentionally self-contained mockups of real dsh-eval output so
the docs stay useful even when no benchmark logs are present.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

FONT_REG = "C:/Windows/Fonts/segoeui.ttf"
FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_MONO = "C:/Windows/Fonts/consola.ttf"


def font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_MONO if mono else FONT_BOLD if bold else FONT_REG
    return ImageFont.truetype(path, size)


def linear_bg(size: tuple[int, int], top: str, bottom: str) -> Image.Image:
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    c0 = Image.new("RGB", (1, 1), top).getpixel((0, 0))
    c1 = Image.new("RGB", (1, 1), bottom).getpixel((0, 0))
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        color = tuple(round(c0[i] * (1 - t) + c1[i] * t) for i in range(3))
        draw.line((0, y, size[0], y), fill=color)
    return image


def pill(draw: ImageDraw.ImageDraw, xy, text, fill, outline=None, text_fill="#ffffff", f=None):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle(xy, radius=(y1 - y0) // 2, fill=fill, outline=outline, width=1)
    f = f or font(20, bold=True)
    box = draw.textbbox((0, 0), text, font=f)
    draw.text(
        (x0 + (x1 - x0 - (box[2] - box[0])) / 2, y0 + (y1 - y0 - (box[3] - box[1])) / 2 - box[1]),
        text, font=f, fill=text_fill,
    )


def hero() -> None:
    w, h = 1600, 640
    image = linear_bg((w, h), "#0b1220", "#15264a")
    d = ImageDraw.Draw(image, "RGBA")

    # Subtle grid.
    for x in range(0, w, 64):
        d.line((x, 0, x, h), fill=(255, 255, 255, 9))
    for y in range(0, h, 64):
        d.line((0, y, w, y), fill=(255, 255, 255, 9))

    d.text((88, 96), "dsh-eval", font=font(104, bold=True), fill="#ffffff")
    d.text((92, 224), "Evidence-grade agent evaluation", font=font(40), fill="#a9c4ff")
    d.text(
        (92, 292),
        "Benchmark YAML  →  headless trials  →  scripted + LLM judging  →  honest reports",
        font=font(26), fill="#cfd9ea",
    )

    badges = [
        ("305 tests", "#2563eb"),
        ("100% coverage", "#067647"),
        ("Linux + Windows", "#7c3aed"),
        ("npm provenance", "#0e7490"),
    ]
    x = 92
    for text, color in badges:
        f = font(22, bold=True)
        box = d.textbbox((0, 0), text, font=f)
        bw = box[2] - box[0] + 40
        pill(d, (x, 368, x + bw, 416), text, color, f=f)
        x += bw + 16

    # Pipeline on the right.
    nodes = [
        (1080, 150, "benchmark.yaml"),
        (1310, 260, "runner"),
        (1080, 380, "judge + stats"),
        (1310, 500, "dashboard"),
    ]
    for (x0, y0, _), (x1, y1, _) in zip(nodes, nodes[1:]):
        d.line((x0 + 90, y0 + 30, x1 + 90, y1 + 30), fill=(122, 162, 255, 150), width=4)
    colors = ["#2563eb", "#7c3aed", "#0e7490", "#067647"]
    for (x0, y0, label), color in zip(nodes, colors):
        d.rounded_rectangle((x0, y0, x0 + 180, y0 + 60), radius=14, fill="#1b3159",
                            outline="#4a6aa8", width=2)
        d.text((x0 + 16, y0 + 16), label, font=font(20, bold=True), fill="#ffffff")

    d.text((92, 560), "No external assets in reports · paired statistics · reproducible seeds",
           font=font(22), fill="#8fa3c4")
    image.save(OUT / "hero.png")


def browser_frame(image: Image.Image, title: str) -> Image.Image:
    w, h = image.size
    frame = Image.new("RGB", (w + 40, h + 92), "#0d1424")
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((0, 0, w + 39, h + 91), radius=20, fill="#0d1424")
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        fd.ellipse((24 + i * 28, 22, 42 + i * 28, 40), fill=c)
    fd.text((140, 19), title, font=font(20), fill="#8da2c5")
    frame.paste(image, (20, 72))
    return frame


def dashboard() -> None:
    w, h = 1520, 980
    image = Image.new("RGB", (w, h), "#f6f7f9")
    d = ImageDraw.Draw(image)
    d.text((44, 28), "swarm-bench · gpt-5", font=font(34, bold=True), fill="#1d2430")
    d.text((44, 72), "source 3f9a1c2e8b04 · judged with rubric-v3", font=font(20), fill="#667085")

    cards = [
        ("COMPLETED", "48/50", "1 timeout · 1 error"),
        ("PASS@1", "78.0%", "strict 72.0%"),
        ("PASS@K", "91.7%", "22 graded cases"),
        ("LATENCY P95", "3.4 s", "p50 1.8 s"),
        ("COST", "$0.0412", "total billed USD"),
    ]
    x = 44
    for label, value, note in cards:
        d.rounded_rectangle((x, 120, x + 280, 232), radius=14, fill="#ffffff", outline="#e3e7ed", width=2)
        d.text((x + 18, 138), label, font=font(16, bold=True), fill="#667085")
        d.text((x + 18, 166), value, font=font(34, bold=True), fill="#1d2430")
        d.text((x + 18, 208), note, font=font(16), fill="#667085")
        x += 296

    def table(top, headers, rows, widths):
        x0 = 44
        d.rounded_rectangle((x0, top, x0 + sum(widths), top + 46 + len(rows) * 40),
                            radius=12, fill="#ffffff", outline="#e3e7ed", width=2)
        cx = x0 + 16
        for head, width in zip(headers, widths):
            d.text((cx, top + 13), head, font=font(16, bold=True), fill="#667085")
            cx += width
        d.line((x0, top + 44, x0 + sum(widths), top + 44), fill="#e3e7ed", width=2)
        for ri, row in enumerate(rows):
            cy = top + 56 + ri * 40
            cx = x0 + 16
            for cell, width in zip(row, widths):
                color = "#067647" if str(cell).startswith("+") else "#b42318" if str(cell).startswith("-") else "#1d2430"
                d.text((cx, cy), str(cell), font=font(18), fill=color)
                cx += width

    d.text((44, 264), "Run comparison", font=font(24, bold=True), fill="#1d2430")
    table(302, ["METRIC", "BASELINE", "CANDIDATE", "CANDIDATE - BASELINE"], [
        ["task success", "68.0%", "78.0%", "+10.0pp"],
        ["strict pass@1", "60.0%", "72.0%", "+12.0pp"],
        ["tool success", "91.0%", "96.0%", "+5.0pp"],
        ["cost / trial", "$0.00082", "$0.00086", "+4.9%"],
    ], [420, 300, 300, 420])

    d.text((44, 552), "Confirmed case changes", font=font(24, bold=True), fill="#1d2430")
    d.text((44, 590), "12 cases · Bonferroni family = 12 · 2 confirmed", font=font(18), fill="#667085")
    table(624, ["CASE", "PAIRS", "B WINS", "A WINS", "ADJUSTED P", "RESULT"], [
        ["retry_on_429", "12", "10", "0", "0.0029", "significantly-better"],
        ["tool_order", "10", "9", "1", "0.0215", "significantly-better"],
    ], [400, 180, 200, 200, 240, 320])

    d.text((44, 820), "Judge calibration", font=font(24, bold=True), fill="#1d2430")
    table(858, ["PASSED MEAN", "FAILED MEAN", "SEPARATION", "RANKING ACCURACY", "BRIER"], [
        ["82.0%", "41.0%", "+41.0pp", "94.0%", "0.184"],
    ], [280, 280, 280, 320, 240])

    browser_frame(image, "dsh-eval dashboard — standalone HTML").save(OUT / "dashboard.png")


def leaderboard() -> None:
    w, h = 1520, 760
    image = Image.new("RGB", (w, h), "#f6f7f9")
    d = ImageDraw.Draw(image)
    d.text((44, 32), "Leaderboard", font=font(38, bold=True), fill="#1d2430")
    d.text((44, 82), "ranked by strict pass@1 · paired evidence against the leader",
           font=font(20), fill="#667085")

    headers = ["RANK", "RUN", "COMPLETED", "TASK", "STRICT PASS@1", "COST/TRIAL", "VS LEADER"]
    widths = [110, 300, 200, 160, 240, 220, 480]
    rows = [
        ["1", "gpt-5", "48/50", "78.0%", "72.0%", "$0.00086", "leader"],
        ["2", "claude-sonnet", "48/50", "74.0%", "68.0%", "$0.00112", "behind-not-significant (p=0.312)"],
        ["3", "gpt-4.1", "46/50", "62.0%", "54.0%", "$0.00074", "significantly-behind (p=0.0029)"],
    ]
    x0, top = 44, 140
    d.rounded_rectangle((x0, top, x0 + sum(widths), top + 56 + len(rows) * 66),
                        radius=14, fill="#ffffff", outline="#e3e7ed", width=2)
    cx = x0 + 18
    for head, width in zip(headers, widths):
        d.text((cx, top + 18), head, font=font(16, bold=True), fill="#667085")
        cx += width
    d.line((x0, top + 52, x0 + sum(widths), top + 52), fill="#e3e7ed", width=2)
    for ri, row in enumerate(rows):
        cy = top + 70 + ri * 66
        if ri % 2 == 1:
            d.rectangle((x0 + 2, cy - 14, x0 + sum(widths) - 2, cy + 44), fill="#fafbfd")
        cx = x0 + 18
        for ci, (cell, width) in enumerate(zip(row, widths)):
            color = "#067647" if ci == 6 and cell == "leader" else "#b42318" if "significantly-behind" in cell else "#1d2430"
            d.text((cx, cy), cell, font=font(19, bold=ci in (1, 6)), fill=color)
            cx += width
    browser_frame(image, "dsh-eval leaderboard — three or more runs").save(OUT / "leaderboard.png")


def cli() -> None:
    w, h = 1520, 840
    image = Image.new("RGB", (w, h), "#0d1424")
    d = ImageDraw.Draw(image)
    lines = [
        ("$ dsh eval run swarm-bench.yaml --out run.json --trials 8 --seed 7", "#7aa2ff"),
        ("[eval] 1/80 hello#1 task pass, 1824 ms, eta 142s", "#cfd9ea"),
        ("[eval] 2/80 hello#2 task fail, 2103 ms, eta 139s", "#cfd9ea"),
        ("[eval] 3/80 retry_on_429#1 task pass, 998 ms, eta 136s", "#cfd9ea"),
        ("Wrote run.json (78/80 completed, tool success 96.0%, strict 72.0%)", "#6ce9a6"),
        ("", "#cfd9ea"),
        ("$ dsh eval gate run.json --baseline base.json --max-drop 0.05 --require-significance", "#7aa2ff"),
        ("# Gate: PASS", "#6ce9a6"),
        ("| check                    | baseline | candidate |      Δ | result |", "#98a2b3"),
        ("|---|---|---|---|---|", "#98a2b3"),
        ("| task success             |    68.0% |     78.0% | +10.0pp | PASS |", "#cfd9ea"),
        ("| strict pass@1 (task)     |    60.0% |     72.0% | +12.0pp | PASS |", "#cfd9ea"),
        ("| paired significance      |   0.0078 |    0.0078 | +0.0000 | PASS |", "#cfd9ea"),
        ("- confirmed case regressions: 2 case(s) survived family correction", "#6ce9a6"),
        ("  - retry_on_429: task success, adjusted p 0.0029", "#cfd9ea"),
        ("  - tool_order: task success, adjusted p 0.0215", "#cfd9ea"),
    ]
    d.text((44, 30), "dsh eval · terminal", font=font(22), fill="#8da2c5")
    for i, (text, color) in enumerate(lines):
        d.text((44, 88 + i * 42), text, font=font(22, mono=True), fill=color)
    browser_frame(image, "CLI").save(OUT / "cli.png")


if __name__ == "__main__":
    hero()
    dashboard()
    leaderboard()
    cli()
    for path in sorted(OUT.glob("*.png")):
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size // 1024} KB")
