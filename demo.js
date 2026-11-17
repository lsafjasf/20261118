(function (root) {
  "use strict";

  const DEMO_DOMAINS = {
    camera: { rate: 29.97, dropFrame: true },
    audio: { rate: 29.97, dropFrame: true },
    timeline: { rate: 29.97, dropFrame: true }
  };

  const DEMO_SYNC_POINTS = [
    {
      id: "demo-sync-1",
      camera: "00:59:50;00",
      audio: "02:30:00;00",
      timeline: "00:00:00;00"
    },
    {
      id: "demo-sync-2",
      camera: "01:29:50;06",
      audio: "02:59:59;26",
      timeline: "00:30:00;00"
    },
    {
      id: "demo-sync-3",
      camera: "01:59:50;13",
      audio: "03:29:59;21",
      timeline: "01:00:00;00"
    }
  ];

  const CONFLICT_SYNC_POINTS = [
    DEMO_SYNC_POINTS[0],
    {
      id: "conflict-sync-2",
      camera: "01:29:50;14",
      audio: "03:00:04;11",
      timeline: "00:30:02;00"
    },
    DEMO_SYNC_POINTS[2]
  ];

  const DEMO_TABLE = {
    sourceKey: "timeline",
    startTimecode: "00:00:00;00",
    endTimecode: "01:00:00;00",
    stepSeconds: 60
  };

  root.SyncDemo = {
    DEMO_DOMAINS,
    DEMO_SYNC_POINTS,
    CONFLICT_SYNC_POINTS,
    DEMO_TABLE
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
