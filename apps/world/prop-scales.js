export const PROP_MODELS = [
  '3dPrinter1.glb', '3dPrinter2.glb',
  'AirConditioner1.glb', 'AirConditioner2.glb', 'AirConditioner3.glb', 'AirConditioner4.glb',
  'ArmourToolBox1.glb', 'ArmourToolBox2.glb', 'ArmourToolBox3.glb', 'ArmourToolMan.glb',
  'Atm1.glb', 'Atm2.glb', 'Atm3.glb', 'Atm4.glb',
  'Ball1.glb',
  'BeerBottle1.glb', 'BeerBottle2.glb', 'BeerBottle3.glb', 'BeerBottle4.glb',
  'BreakRoomChair1.glb', 'BreakRoomChair2.glb', 'BreakRoomChair3.glb', 'BreakRoomChair4.glb',
  'BreakRoomCouch1.glb', 'BreakRoomCouch2.glb', 'BreakRoomCouch3.glb', 'BreakRoomCouch4.glb', 'BreakRoomCouch5.glb', 'BreakRoomCouch6.glb', 'BreakRoomCouch7.glb',
  'BreakRoomTable1.glb', 'BreakRoomTable2.glb',
  'BrokenBeerBottles1.glb', 'BrokenBeerBottles2.glb',
  'BrokenOfficeChair1.glb', 'BrokenOfficeChair2.glb',
  'BrokenWaterCooler1.glb', 'BrokenWaterCooler2.glb',
  'CanMan1.glb', 'CanMan2.glb', 'CanMan3.glb',
  'CashRegister1.glb', 'CashRegister2.glb', 'CashRegister3.glb',
  'ComfyChairs1.glb',
  'CrushedGarbageCan1.glb', 'CrushedGarbageCan2.glb', 'CrushedGarbageCan3.glb', 'CrushedGarbageCan4.glb',
  'DinnerTable1.glb', 'DinnerTable2.glb', 'DinnerTable3.glb',
  'dj_mixer_baeeec4e_v1.glb', 'dj_mixer_baeeec4e_v2.glb', 'dj_mixer_baeeec4e_v3.glb', 'dj_mixer_baeeec4e_v4.glb',
  'fancy_reception_desk_58fde71d_v1.glb', 'fancy_reception_desk_58fde71d_v2.glb', 'fancy_reception_desk_58fde71d_v3.glb', 'fancy_reception_desk_58fde71d_v4.glb',
  'heavy_machinery__crane_from_junk_yard_with_magnet_for_lifting_cars_db884752_v1.glb', 'heavy_machinery__crane_from_junk_yard_with_magnet_for_lifting_cars_db884752_v2.glb', 'heavy_machinery__crane_from_junk_yard_with_magnet_for_lifting_cars_db884752_v3.glb',
  'hi-fi_sound_system_2a2cc620_v1.glb', 'hi-fi_sound_system_2a2cc620_v2.glb', 'hi-fi_sound_system_2a2cc620_v3.glb', 'hi-fi_sound_system_2a2cc620_v4.glb',
  'industrial_pipe_cb740c0c_v1.glb', 'industrial_pipe_cb740c0c_v2.glb', 'industrial_pipe_cb740c0c_v3.glb', 'industrial_pipe_cb740c0c_v4.glb',
  'l-shaped_industrial_pipe_3b570c7e_v1.glb', 'l-shaped_industrial_pipe_3b570c7e_v2.glb', 'l-shaped_industrial_pipe_3b570c7e_v3.glb', 'l-shaped_industrial_pipe_3b570c7e_v4.glb',
  'l-shaped_industrial_pipe_f7fd8524_v1.glb', 'l-shaped_industrial_pipe_f7fd8524_v2.glb', 'l-shaped_industrial_pipe_f7fd8524_v3.glb', 'l-shaped_industrial_pipe_f7fd8524_v4.glb',
  'night_club_speakers_9155e359_v1.glb',
  'old_cheap_couch_with_a_bad_floral_pattern_53278f1b_v1.glb', 'old_cheap_couch_with_a_bad_floral_pattern_53278f1b_v2.glb', 'old_cheap_couch_with_a_bad_floral_pattern_53278f1b_v3.glb', 'old_cheap_couch_with_a_bad_floral_pattern_53278f1b_v4.glb',
  'server_rack_03b09d1f_v1.glb', 'server_rack_03b09d1f_v2.glb', 'server_rack_03b09d1f_v3.glb', 'server_rack_03b09d1f_v4.glb',
  'server_rack_c2999a18_v1.glb', 'server_rack_c2999a18_v2.glb', 'server_rack_c2999a18_v3.glb', 'server_rack_c2999a18_v4.glb',
  'shop_counter_f668a712_v1.glb',
  'warehouse_crate_6e8a0927_v1.glb', 'warehouse_crate_6e8a0927_v2.glb', 'warehouse_crate_6e8a0927_v4.glb',
  'water_tank_c27c18f7_v1.glb', 'water_tank_c27c18f7_v2.glb', 'water_tank_c27c18f7_v3.glb', 'water_tank_c27c18f7_v4.glb',
]

const SCALE_KEYWORDS = [
  [['beerbottle', 'brokenbeerbottles'], 0.07],
  [['canman'], 0.12],
  [['ball'], 0.22],
  [['breakroomcouch', 'comfychairs', 'old_cheap_couch'], 0.95],
  [['brokenofficechair'], 0.6],
  [['breakroomchair', 'officechair'], 0.9],
  [['breakroomtable', 'dinnertable'], 0.85],
  [['atm'], 0.5],
  [['cashregister'], 0.35],
  [['watercooler', 'brokenwatercooler'], 0.45],
  [['garbagecan', 'crushedgarbagecan'], 0.35],
  [['armourman', 'armourtoolman'], 1.1],
  [['armourtoolbox', 'toolbox'], 0.4],
  [['airconditioner'], 0.8],
  [['3dprinter'], 0.45],
  [['dj_mixer'], 0.5],
  [['server_rack'], 1.0],
  [['hi-fi', 'hi_fi', 'hifi', 'sound_system'], 0.6],
  [['night_club_speakers', 'speakers'], 0.8],
  [['heavy_machinery', 'crane'], 3.5],
  [['l-shaped'], 1.0],
  [['industrial_pipe'], 1.2],
  [['fancy_reception_desk'], 1.1],
  [['shop_counter'], 0.9],
  [['warehouse_crate'], 1.0],
  [['water_tank'], 1.2],
]

export function getPropScale(filename) {
  const vMatch = filename.match(/_v(\d+)\.glb$/i) || filename.match(/(\d+)\.glb$/i)
  const variant = vMatch ? parseInt(vMatch[1], 10) - 1 : 0
  const base = filename.replace(/(_v\d+)?\.glb$/i, '').toLowerCase()

  for (const [keywords, scale] of SCALE_KEYWORDS) {
    if (keywords.some(k => base.includes(k))) {
      return scale + variant * 0.02
    }
  }
  return 0.8 + variant * 0.02
}
