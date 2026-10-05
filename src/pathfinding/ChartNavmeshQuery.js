export class ChartNavmeshQuery {
  constructor(navmesh, ledgerOf) {
    this.navmesh = navmesh
    this._ledgerOf = ledgerOf
    this._epoch = -1
    this._toBase = null
    this._fromBase = null
  }

  _transfers() {
    const ledger = this._ledgerOf()
    if (!ledger || ledger.currentEpoch === ledger.base.chartEpoch) return null
    if (this._epoch !== ledger.currentEpoch) {
      this._epoch = ledger.currentEpoch
      this._toBase = ledger.transferToBase()
      this._fromBase = ledger.transferFromBase()
    }
    return this
  }

  findPath(start, goal) {
    const t = this._transfers()
    if (!t) return this.navmesh.findPath(start, goal)
    const path = this.navmesh.findPath(t._toBase.point(start), t._toBase.point(goal))
    return path && path.map(p => t._fromBase.point(p))
  }

  locate(point) {
    const t = this._transfers()
    return this.navmesh.locate(t ? t._toBase.point(point) : point)
  }

  clearCache() { this.navmesh.clearCache() }

  get data() { return this.navmesh.data }

  get bounds() { return this.navmesh.bounds }

  get config() { return this.navmesh.config }
}
