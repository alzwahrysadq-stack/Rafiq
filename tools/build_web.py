"""يبني أصول الواجهة من القوالب المعتمدة في المرجع، بدون Flask وبدون تعديل محتوى الشاشات.

الاستعمال (مرة عند تغيير القوالب أو app.py):
    python3 tools/build_web.py [مجلد_المرجع]     (الافتراضي: ../rafiq_standalone/reference)

يكتب في app/src/main/assets/web/ :
- templates.js : القوالب بعد تحويل بسيط من صيغة Jinja إلى صيغة nunjucks (تتشابه تقريباً).
- routes.js    : خريطة اسم الدالة (endpoint) إلى المسار، مُستخرجة من app.py، لدالة url_for.
- static/      : app.js و style.css والخطوط والشعار، مع مسارات نسبية.
- index.html   : الصفحة المضيفة؛ تحمّل nunjucks ثم engine.js (مكتوب يدوياً في نفس المجلد).
"""
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
REF = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(REPO), "reference")
OUT = os.path.join(REPO, "app", "src", "main", "assets", "web")
KEEP = {"engine.js", "cloud-shift.js", "cloud-ledger.js", "vendor"}   # ملفات مكتوبة يدوياً تبقى كما هي


def jinja_to_nunjucks(src):
    # {% with x = expr %} ... {% endwith %}  →  {% set x = expr %}
    src = re.sub(r"\{%\s*with\s+(\w+)\s*=\s*(.*?)\s*%\}", r"{% set \1 = \2 %}", src)
    src = re.sub(r"\{%\s*endwith\s*%\}", "", src)
    # الشرائح بأسلوب بايثون: x[11:16] → x | slice(11, 16)
    src = re.sub(r"([\w.]+)\[(\d*):(\d*)\]",
                 lambda m: "%s | slice(%s, %s)" % (m.group(1), m.group(2) or "0", m.group(3) or "999999"), src)
    src = src.replace(" is none", " == null")
    return src


def read_routes():
    text = open(os.path.join(REF, "app.py"), encoding="utf-8").read()
    pat = re.compile(r'@app\.(?:route|get|post)\(\s*"([^"]+)"[^\n]*\)\s*\n(?:@[^\n]*\n\s*)*def (\w+)\(')
    routes = {}
    for rule, name in pat.findall(text):
        routes.setdefault(name, rule)
    return routes


def main():
    if os.path.exists(OUT):
        for name in os.listdir(OUT):
            if name in KEEP:
                continue
            p = os.path.join(OUT, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(OUT, exist_ok=True)

    tdir = os.path.join(REF, "templates")
    templates = {}
    for fn in sorted(os.listdir(tdir)):
        if fn.endswith(".html"):
            with open(os.path.join(tdir, fn), encoding="utf-8") as f:
                templates[fn] = jinja_to_nunjucks(f.read())
    # قوالب إضافية للتطبيق (مثل /license) تُدمج فوق قوالب المرجع؛ إن تطابق اسم فهي تحل محله
    extra = os.path.join(REPO, "templates_extra")
    if os.path.isdir(extra):
        for fn in sorted(os.listdir(extra)):
            if fn.endswith(".html"):
                with open(os.path.join(extra, fn), encoding="utf-8") as f:
                    templates[fn] = jinja_to_nunjucks(f.read())
    js = json.dumps(templates, ensure_ascii=False).replace("</", "<\\/")
    with open(os.path.join(OUT, "templates.js"), "w", encoding="utf-8") as f:
        f.write("window.RAFIQ_TEMPLATES = " + js + ";\n")

    routes = read_routes()
    routes.setdefault("license", "/license")   # صفحة الرخصة مضافة في التطبيق، وليست في المرجع
    with open(os.path.join(OUT, "routes.js"), "w", encoding="utf-8") as f:
        f.write("window.RAFIQ_ROUTES = " + json.dumps(routes, ensure_ascii=False) + ";\n")

    # الملفات الثابتة مع تحويل المسارات المطلقة إلى نسبية
    dst = os.path.join(OUT, "static")
    shutil.copytree(os.path.join(REF, "static"), dst)
    for root, _, files in os.walk(dst):
        for fn in files:
            if fn.endswith((".css", ".js")):
                p = os.path.join(root, fn)
                with open(p, encoding="utf-8") as f:
                    txt = f.read()
                txt = re.sub(r"(['\"(])/static/", r"\1static/", txt)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(txt)
    # CSS refinements from #83 are not in the old Flask reference. Always restore
    # them when rebuilding; otherwise compiling new templates erases phone layout.
    additions = os.path.join(HERE, "web_style_overrides.css")
    if os.path.isfile(additions):
        with open(os.path.join(dst, "style.css"), "a", encoding="utf-8") as f:
            with open(additions, encoding="utf-8") as source:
                f.write("\n" + source.read())

    index = """<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>رفيق</title>
</head>
<body>
<script src="vendor/nunjucks.min.js"></script>
<script src="routes.js"></script>
<script src="templates.js"></script>
<script src="engine.js"></script>
</body>
</html>
"""
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(index)
    print("ok:", len(templates), "templates,", len(routes), "routes")


if __name__ == "__main__":
    main()
