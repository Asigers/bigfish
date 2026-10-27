import {mkdirSync} from "node:fs";
import {dirname,join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {Action,GameState} from "./types.ts";
import type {FarmDayOutcome} from "./farm-plan.ts";
import {gameOrdinal} from "./campaign.ts";

export type HistoricalMetrics={
  recordedDays:number; openingGold:number; closingGold:number; netGoldChange:number;
  planted:number;watered:number;harvested:number;failed:number;
  verifiedActions:number;verifiedWaterActions:number;
  meanWaterEnergy:number;
  observedFailureRate:number;
};
const defaultFile=join(process.cwd(),"data","bigfish-history.sqlite");
const sameGame=(a:GameState,b:GameState)=>a.saveId===b.saveId;
export class FarmHistory {
  private db:DatabaseSync;
  constructor(path=defaultFile){
    mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verified_actions(
        save_id TEXT NOT NULL, command_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, action_type TEXT NOT NULL,
        succeeded INTEGER NOT NULL CHECK(succeeded IN(0,1)),
        energy_spent REAL NOT NULL CHECK(energy_spent>=0),
        gold_delta INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(save_id,command_id)
      );
      CREATE INDEX IF NOT EXISTS actions_by_save_day
        ON verified_actions(save_id,ordinal);
      CREATE TABLE IF NOT EXISTS farm_days(
        save_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        day_key TEXT NOT NULL, target_plots INTEGER NOT NULL,
        opening_gold INTEGER NOT NULL, closing_gold INTEGER NOT NULL,
        planted INTEGER NOT NULL, watered INTEGER NOT NULL,
        harvested INTEGER NOT NULL, failed INTEGER NOT NULL,
        PRIMARY KEY(save_id,ordinal)
      );
    `);
  }
  /** A repeated or recovered receipt cannot inflate observed work and energy. */
  recordVerifiedAction(before:GameState,after:GameState,action:Action,
    commandId:string,ok:boolean):boolean{
    if(!sameGame(before,after)||!commandId||commandId.length>160||
      before.season!==after.season||before.day!==after.day||
      (before.year??1)!==(after.year??1))return false;
    const supported=["plant_seed","till_tile","water_tile","harvest_crop",
      "collect_forage","clear_resource","pickup_drop","buy_seed",
      "ship_item","craft_chest","place_chest","craft_sprinkler","place_sprinkler"];
    if(!supported.includes(action.type))return false;
    const energy=Math.max(0,Math.min(1000,before.energy-after.energy));
    const goldDelta=(after.economy?.gold??before.economy?.gold??0)-
      (before.economy?.gold??0);
    const result=this.db.prepare(`INSERT OR IGNORE INTO verified_actions
      (save_id,command_id,ordinal,action_type,succeeded,energy_spent,gold_delta)
      VALUES (?,?,?,?,?,?,?)`).run(
      before.saveId,commandId,gameOrdinal(before),action.type,ok?1:0,energy,goldDelta);
    return result.changes===1;
  }
  recordCompletedDay(saveId:string,ordinal:number,o:FarmDayOutcome):void{
    if(!saveId||!Number.isInteger(ordinal)||ordinal<0||
      !Number.isInteger(o.openingGold)||!Number.isInteger(o.closingGold)||
      !Number.isInteger(o.planted)||!Number.isInteger(o.watered)||
      !Number.isInteger(o.harvested)||!Number.isInteger(o.failed))return;
    this.db.prepare(`INSERT INTO farm_days
      (save_id,ordinal,day_key,target_plots,opening_gold,closing_gold,
       planted,watered,harvested,failed)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(save_id,ordinal) DO UPDATE SET
       closing_gold=excluded.closing_gold,
       planted=MAX(farm_days.planted,excluded.planted),
       watered=MAX(farm_days.watered,excluded.watered),
       harvested=MAX(farm_days.harvested,excluded.harvested),
       failed=MAX(farm_days.failed,excluded.failed)`).run(
      saveId,ordinal,o.dayKey,o.targetPlots,o.openingGold,o.closingGold,
      o.planted,o.watered,o.harvested,o.failed);
  }
  metrics(saveId:string,untilOrdinal?:number,windowDays=14):HistoricalMetrics{
    if(!saveId)return {recordedDays:0,openingGold:0,closingGold:0,netGoldChange:0,
      planted:0,watered:0,harvested:0,failed:0,
      verifiedActions:0,verifiedWaterActions:0,meanWaterEnergy:0,observedFailureRate:0};
    const last=untilOrdinal??Number((this.db.prepare(
      "SELECT MAX(ordinal) AS d FROM farm_days WHERE save_id=?"
    ).get(saveId) as {d:number|null}).d??0);
    const min=Math.max(0,last-Math.max(1,Math.min(112,windowDays))+1);
    const days=this.db.prepare(`SELECT * FROM farm_days WHERE save_id=? AND
      ordinal BETWEEN ? AND ? ORDER BY ordinal ASC`).all(saveId,min,last) as
      {opening_gold:number;closing_gold:number;planted:number;watered:number;
       harvested:number;failed:number}[];
    const actions=this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN succeeded=0 THEN 1 ELSE 0 END) AS failures,
      SUM(CASE WHEN action_type='water_tile' AND succeeded=1 THEN 1 ELSE 0 END) AS water_count,
      SUM(CASE WHEN action_type='water_tile' AND succeeded=1 THEN energy_spent ELSE 0 END) AS water_energy
      FROM verified_actions WHERE save_id=? AND ordinal BETWEEN ? AND ?`
    ).get(saveId,min,last) as {total:number;failures:number|null;water_count:number|null;water_energy:number|null};
    const first=days[0],final=days.at(-1),count=actions.total??0,water=actions.water_count??0;
    return {recordedDays:days.length,openingGold:first?.opening_gold??0,
      closingGold:final?.closing_gold??0,netGoldChange:
      days.reduce((n,d)=>n+d.closing_gold-d.opening_gold,0),
      planted:days.reduce((n,d)=>n+d.planted,0),
      watered:days.reduce((n,d)=>n+d.watered,0),
      harvested:days.reduce((n,d)=>n+d.harvested,0),
      failed:days.reduce((n,d)=>n+d.failed,0),
      verifiedActions:count,verifiedWaterActions:water,
      meanWaterEnergy:water>0?(actions.water_energy??0)/water:0,
      observedFailureRate:count>0?(actions.failures??0)/count:0};
  }
  close():void{this.db.close();}
}
