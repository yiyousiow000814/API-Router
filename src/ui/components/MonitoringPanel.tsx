import type { Status } from '../types'

export function MonitoringPanel({ status: _status }: { status: Status; gatewayTokenPreview: string }) {
  return (
    <div className="aoCard" style={{ margin: 24 }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">Monitoring</div>
      </div>
      <div style={{ padding: 16 }}>
        Monitoring page placeholder — will be implemented in Task 5.
      </div>
    </div>
  )
}
