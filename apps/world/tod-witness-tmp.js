// throwaway tod-rebuild-witness.mjs world -- safe to delete
export default {
  "port": 40467,
  "tickRate": 60,
  "gravity": [
    0,
    -9.81,
    0
  ],
  "spawnPoint": [
    0,
    5,
    8
  ],
  "terrain": {
    "timeOfDay": {
      "serverAuthoritative": true,
      "dayLengthSec": 600,
      "startFraction": 0.05
    }
  },
  "entities": [
    {
      "id": "witness-box",
      "app": "box-static",
      "position": [
        0,
        1,
        0
      ]
    }
  ]
}
