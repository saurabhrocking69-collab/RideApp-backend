// Mutable singletons — admin updates these at runtime via API
// All route files share the same object reference (Node.js module cache)

const HOURLY_FARES = {
  auto:          { 2:{fare:180,km:20}, 4:{fare:320,km:40}, 6:{fare:460,km:60}, 8:{fare:580,km:80},  24:{fare:1500,km:200}, 48:{fare:2800,km:400}, 72:{fare:4000,km:600}, extra:8  },
  bike:          { 2:{fare:120,km:20}, 4:{fare:210,km:40}, 6:{fare:300,km:60}, 8:{fare:380,km:80},  24:{fare:1000,km:200}, 48:{fare:1800,km:400}, 72:{fare:2600,km:600}, extra:5  },
  car:           { 2:{fare:260,km:20}, 4:{fare:460,km:40}, 6:{fare:660,km:60}, 8:{fare:840,km:80},  24:{fare:2200,km:200}, 48:{fare:4000,km:400}, 72:{fare:5800,km:600}, extra:12 },
  eriksha:       { 2:{fare:150,km:20}, 4:{fare:270,km:40}, 6:{fare:390,km:60}, 8:{fare:490,km:80},  24:{fare:1200,km:200}, 48:{fare:2200,km:400}, 72:{fare:3200,km:600}, extra:7  },
  ultra_luxury:  { 2:{fare:800,km:20}, 4:{fare:1400,km:40}, 6:{fare:2000,km:60}, 8:{fare:2600,km:80}, 24:{fare:6000,km:200}, 48:{fare:10000,km:400}, 72:{fare:14000,km:600}, extra:25 },
  green_bike:    { 2:{fare:100,km:20}, 4:{fare:180,km:40}, 6:{fare:260,km:60}, 8:{fare:330,km:80},  24:{fare:850,km:200},  48:{fare:1500,km:400}, 72:{fare:2200,km:600}, extra:4  },
  electric_auto: { 2:{fare:130,km:20}, 4:{fare:240,km:40}, 6:{fare:350,km:60}, 8:{fare:440,km:80},  24:{fare:1100,km:200}, 48:{fare:2000,km:400}, 72:{fare:2900,km:600}, extra:6  },
};

let SURGE_MULTIPLIER = 1.0;

module.exports = { HOURLY_FARES, getSurge: () => SURGE_MULTIPLIER, setSurge: (v) => { SURGE_MULTIPLIER = v; } };
