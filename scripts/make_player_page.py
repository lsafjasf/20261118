"""Generate a self-contained HTML5 chapter-jump verification page."""
import json

from common import OUT, VERIFY, load_json


def main() -> None:
    data = load_json(OUT / "chapter_map.json")
    plan = load_json(VERIFY / "player_jump_verification.json")
    rows = []
    for chapter, check in zip(data["chapters"], plan["jump_checks"][: len(data["chapters"])]):
        rows.append(
            {
                "index": chapter["index"],
                "start": chapter["new_time"]["start_sec"],
                "end": chapter["new_time"]["end_sec"],
                "source_frame": chapter["old_time"]["start_frame"],
                "zh": chapter["titles"]["zh"],
                "en": chapter["titles"]["en"],
                "ja": chapter["titles"]["ja"],
                "psnr": check["psnr_db"],
            }
        )
    payload = json.dumps(rows, ensure_ascii=False)
    html = f"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>章节跳转验证播放器</title>
<style>
  body {{ font-family: "Noto Sans CJK SC", sans-serif; margin: 24px; background:#111; color:#eee; }}
  video {{ width: 880px; max-width:100%; background:#000; }}
  table {{ border-collapse: collapse; margin-top:16px; width: 880px; max-width:100%; }}
  th, td {{ border:1px solid #444; padding:6px 10px; font-size:14px; }}
  tr {{ cursor: pointer; }}
  tr:hover {{ background:#223; }}
  .ok {{ color:#7d7; }}
  #status {{ margin-top:10px; color:#9cf; font-family:monospace; }}
</style>
</head>
<body>
<h2>成片章节跳转检查（点击任意章节即模拟播放器跳转）</h2>
<video id="player" src="../out/edited_with_chapters.mp4" controls preload="auto"></video>
<div id="status">就绪。当前章节：-</div>
<table>
<thead><tr><th>#</th><th>新时间</th><th>源帧</th><th>中文标题</th><th>English</th><th>日本語</th><th>跳转帧 PSNR</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<script>
const CHAPTERS = {payload};
const player = document.getElementById('player');
const statusEl = document.getElementById('status');
const tbody = document.getElementById('rows');
CHAPTERS.forEach(c => {{
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${{c.index}}</td><td>${{c.start.toFixed(3)}}–${{c.end.toFixed(3)}}s</td>`
    + `<td>${{c.source_frame}}</td><td>${{c.zh}}</td><td>${{c.en}}</td><td>${{c.ja}}</td>`
    + `<td class="ok">${{c.psnr.toFixed(2)}} dB</td>`;
  tr.onclick = () => {{
    player.currentTime = c.start;
    player.play();
    statusEl.textContent = `跳转到章节 #${{c.index}}「${{c.zh}}」 目标新时间 ${{c.start.toFixed(3)}}s，预期源帧 ${{c.source_frame}}`;
  }};
  tbody.appendChild(tr);
}});
player.addEventListener('timeupdate', () => {{
  const current = CHAPTERS.find(c => player.currentTime >= c.start && player.currentTime < c.end);
  if (current) statusEl.dataset.chapter = current.index;
}});
</script>
</body>
</html>
"""
    out = VERIFY / "chapter_player.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
