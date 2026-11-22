"""Generate PrintKit Splash Screen (splash.png), Windows Icon (app.ico), and Web Header Icon (public/printkit_icon.png)."""
import os
from PIL import Image, ImageDraw, ImageFont

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
LOGO_PATH = os.path.join(BASE_DIR, "printkit_logo.png")


def load_font(size, weight="regular"):
    if weight == "bold":
        candidates = [r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"]
    elif weight == "light":
        candidates = [r"C:\Windows\Fonts\segoeuil.ttf", r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"]
    else:
        candidates = [r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def trim_whitespace(img: Image.Image, threshold=245) -> Image.Image:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    pix = rgba.load()
    min_x, min_y, max_x, max_y = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = pix[x, y]
            if a > 20 and (r < threshold or g < threshold or b < threshold):
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x <= min_x or max_y <= min_y:
        return rgba
    return rgba.crop((min_x, min_y, max_x + 1, max_y + 1))


def extract_emblem(logo_trimmed: Image.Image) -> Image.Image:
    """Split off the top PrintKit P-mark emblem (above the blank gap separating it from 'PrintKit' text)."""
    w, h = logo_trimmed.size
    pix = logo_trimmed.load()
    # Scan rows from top to find the first completely white/empty band after row 30% of height
    split_y = int(h * 0.65)
    seen_ink = False
    for y in range(int(h * 0.15), int(h * 0.85)):
        has_ink = False
        for x in range(0, w, 2):
            r, g, b, a = pix[x, y]
            if a > 20 and (r < 245 or g < 245 or b < 245):
                has_ink = True
                break
        if has_ink:
            seen_ink = True
        elif seen_ink and y > int(h * 0.45):
            split_y = y
            break
    return trim_whitespace(logo_trimmed.crop((0, 0, w, split_y)))


def build_icons(emblem: Image.Image):
    size = 256
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle([8, 8, size - 8, size - 8], radius=48, fill=(255, 255, 255, 255), outline=(22, 36, 64, 255), width=6)

    # Fit emblem cleanly inside tile with generous padding
    ew, eh = emblem.size
    max_inner = 186
    scale = min(max_inner / max(1, ew), max_inner / max(1, eh))
    nw, nh = max(1, int(ew * scale)), max(1, int(eh * scale))
    emblem_resized = emblem.resize((nw, nh), Image.Resampling.LANCZOS)
    tile.alpha_composite(emblem_resized, ((size - nw) // 2, (size - nh) // 2))

    ico_path = os.path.join(BASE_DIR, "app.ico")
    tile.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"Generated {ico_path}")

    web_icon_path = os.path.join(PROJECT_ROOT, "public", "printkit_icon.png")
    tile.resize((128, 128), Image.Resampling.LANCZOS).save(web_icon_path, format="PNG")
    print(f"Generated {web_icon_path}")


def build_splash(logo_trimmed: Image.Image):
    w, h = 640, 360
    img = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Subtle light prepress grid background
    for x in range(20, w - 20, 28):
        draw.line([(x, 20), (x, h - 20)], fill=(241, 245, 249, 255), width=1)
    for y in range(20, h - 20, 28):
        draw.line([(20, y), (w - 20, y)], fill=(241, 245, 249, 255), width=1)

    # Outer sleek navy border
    navy = (22, 36, 64, 255)
    orange = (249, 99, 40, 255)
    draw.rectangle([1, 1, w - 2, h - 2], outline=navy, width=2)

    # 4 corner registration crop marks
    for cx, cy, dx, dy in [(22, 22, 1, 1), (w - 22, 22, -1, 1), (22, h - 22, 1, -1), (w - 22, h - 22, -1, -1)]:
        draw.line([(cx, cy), (cx + dx * 16, cy)], fill=navy, width=2)
        draw.line([(cx, cy), (cx, cy + dy * 16)], fill=navy, width=2)

    # Place PrintKit full logo centered with balanced breathing room
    lw, lh = logo_trimmed.size
    scale = min(300 / max(1, lw), 160 / max(1, lh))
    nw, nh = max(1, int(lw * scale)), max(1, int(lh * scale))
    logo_resized = logo_trimmed.resize((nw, nh), Image.Resampling.LANCZOS)
    logo_y = 48
    img.alpha_composite(logo_resized, ((w - nw) // 2, logo_y))

    # Minimalist light-weight gray subtitle right below "PrintKit"
    f_sub = load_font(16, weight="light")
    f_foot = load_font(13, weight="regular")
    subtitle = "Giải pháp xử lý File In ấn chuyên nghiệp"
    sb = draw.textbbox((0, 0), subtitle, font=f_sub)
    sw = sb[2] - sb[0]
    draw.text(((w - sw) // 2 - sb[0], logo_y + nh + 18), subtitle, fill=(100, 116, 139, 255), font=f_sub)

    # Progress bar track (Navy + PrintKit Orange fill)
    draw.rounded_rectangle([48, 282, w - 48, 290], radius=4, fill=(226, 232, 240, 255))
    draw.rounded_rectangle([48, 282, 280, 290], radius=4, fill=orange)

    draw.text((48, 304), "Đang khởi tạo hệ thống xử lý PDF...", fill=(71, 85, 105, 255), font=f_foot)
    draw.text((w - 148, 304), "Desktop Edition", fill=navy, font=f_foot)

    splash_path = os.path.join(BASE_DIR, "splash.png")
    img.convert("RGB").save(splash_path, format="PNG")
    print(f"Generated {splash_path}")


if __name__ == "__main__":
    raw = Image.open(LOGO_PATH)
    trimmed = trim_whitespace(raw)
    emblem = extract_emblem(trimmed)
    build_icons(emblem)
    build_splash(trimmed)
