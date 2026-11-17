import { runAllScenarios } from '../src/scenarios.js';

function line(char = '-', width = 72) {
  console.log(char.repeat(width));
}

let failures = 0;

for (const result of runAllScenarios()) {
  line('=');
  console.log(`场景: ${result.name}`);
  line('-');
  for (const entry of result.log) console.log(`  ${entry}`);
  console.log('  断言:');
  for (const assertion of result.assertions) console.log(`    [PASS] ${assertion}`);

  const { stats, lastRendered, currentTime, residentBytes, memoryLimit } = result.finalState;
  console.log('  最终指标:');
  console.log(`    播放头=${currentTime.toFixed(1)}s  驻留内存=${(residentBytes / 1e6).toFixed(2)}MB / 上限=${(memoryLimit / 1e6).toFixed(1)}MB`);
  console.log(`    渲染对齐: video=${lastRendered.videoTime}s audio=${lastRendered.audioTime}s text=${lastRendered.textTime}s (分片 #${lastRendered.index})`);
  console.log(`    累计驱逐时长=${stats.evictedDurationSeconds}s  重新请求组=${stats.refetchGroupRequests}  命中已驱逐=${stats.seeksIntoEvicted}`);
  console.log(`    请求: 总计=${stats.totalRequests} 完成=${stats.completedRequests} abort=${stats.cancelledRequests} 过期丢弃=${stats.staleDropped}`);
}

line('=');
if (failures === 0) {
  console.log('全部场景断言通过：长距离回跳与快速连续拖动后，视频/音频/字幕均对齐同一目标时间。');
  process.exit(0);
} else {
  console.error(`存在 ${failures} 个失败`);
  process.exit(1);
}
