import { Box, Button, Card, CardContent, Chip, Divider, Paper, Radio, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import type { ImportStagingRecord } from '../../types/offline-pack'
import { useImportStore } from '../../stores/importStore'
import { kindLabel } from '../../utils/merge'

const statusMeta: Record<ImportStagingRecord['status'], { label: string; color: 'success' | 'info' | 'warning' }> = {
  new: { label: '新增', color: 'success' },
  identical: { label: '一致', color: 'info' },
  conflict: { label: '有分歧', color: 'warning' },
}

function rowState(record: ImportStagingRecord): { state: 'applied' | 'held' | 'awaiting' | 'ready'; hint: string } {
  if (record.applied) return { state: 'applied', hint: record.appliedAt ? `已于 ${record.appliedAt.slice(0, 16).replace('T', ' ')} 写入台账` : '已写入台账' }
  if (record.missingUpstreams.length > 0) return { state: 'held', hint: '缺上游，暂存待处理' }
  if (record.status === 'conflict' && !record.chosenSide && !record.fieldChoices) {
    return { state: 'awaiting', hint: '请先在分歧字段中选定取值' }
  }
  return { state: 'ready', hint: '可写入' }
}

function FieldChoiceCell({ record, field, label, local, remote }: {
  record: ImportStagingRecord
  field: string
  label: string
  local: string
  remote: string
}) {
  const chooseField = useImportStore((state) => state.chooseField)
  const divergent = local !== remote
  // 新增记录本机无原值，不允许把空的“本机侧”选成取值
  const selectable = divergent && record.status !== 'new' && !record.applied
  const base = record.chosenSide ?? 'remote'
  const choice = record.fieldChoices?.[field] ?? base

  return (
    <TableRow hover={false} sx={{ '& > *': { borderBottom: 'unset', py: 0.5 } }}>
      <TableCell sx={{ width: 150, color: 'text.secondary' }}>{label}</TableCell>
      <TableCell sx={{ minWidth: 150 }}>
        <Box
          component="label"
          sx={{ display: 'inline-flex', alignItems: 'center', cursor: selectable && choice === 'local' ? 'pointer' : 'default', borderRadius: 1, px: 0.5, bgcolor: selectable && choice === 'local' ? '#e8f0e3' : undefined, fontWeight: divergent ? 650 : 400 }}
          data-testid={`local-${record.businessNo}-${field}`}
        >
          <Radio
            size="small"
            disabled={!selectable}
            checked={record.status !== 'new' && choice === 'local'}
            onChange={() => void chooseField(record.key, field, 'local')}
            sx={{ p: 0.25 }}
          />
          <Box component="span" sx={{ ml: 0.5 }}>{local || '—'}</Box>
        </Box>
      </TableCell>
      <TableCell sx={{ minWidth: 150 }}>
        <Box
          component="label"
          sx={{ display: 'inline-flex', alignItems: 'center', cursor: selectable ? 'pointer' : 'default', borderRadius: 1, px: 0.5, bgcolor: divergent && choice === 'remote' ? '#e8f0e3' : undefined, fontWeight: divergent ? 650 : 400 }}
          data-testid={`remote-${record.businessNo}-${field}`}
        >
          <Radio
            size="small"
            disabled={!selectable}
            checked={choice === 'remote'}
            onChange={() => void chooseField(record.key, field, 'remote')}
            sx={{ p: 0.25 }}
          />
          <Box component="span" sx={{ ml: 0.5 }}>{remote || '—'}</Box>
        </Box>
      </TableCell>
    </TableRow>
  )
}

function StagingCard({ record }: { record: ImportStagingRecord }) {
  const chooseSide = useImportStore((state) => state.chooseSide)
  const meta = statusMeta[record.status]
  const state = rowState(record)
  const divergentFields = record.fields.filter((field) => field.local !== field.remote)

  return (
    <Paper
      variant="outlined"
      data-testid={`staging-${record.kind}-${record.businessNo}`}
      data-state={state.state}
      sx={{ p: 1.5, borderColor: state.state === 'held' ? '#d9a85f' : state.state === 'applied' ? '#b7c8ae' : undefined, bgcolor: state.state === 'applied' ? '#f4f7f0' : undefined }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontWeight: 800 }}>{record.businessNo}</Typography>
          <Chip size="small" color={meta.color} label={meta.label} />
          {state.state === 'applied' && <Chip size="small" color="success" variant="outlined" label="已写入" />}
          {state.state === 'held' && <Chip size="small" color="warning" label="暂存待处理" />}
        </Box>
        {record.status === 'conflict' && !record.applied && (
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Button
              size="small"
              variant={record.chosenSide === 'local' && !record.fieldChoices ? 'contained' : 'outlined'}
              onClick={() => void chooseSide(record.key, 'local')}
              data-testid={`use-local-${record.businessNo}`}
            >
              全用本机
            </Button>
            <Button
              size="small"
              variant={!record.chosenSide || (record.chosenSide === 'remote' && !record.fieldChoices) ? 'contained' : 'outlined'}
              onClick={() => void chooseSide(record.key, 'remote')}
              data-testid={`use-remote-${record.businessNo}`}
            >
              全用离线包
            </Button>
          </Box>
        )}
      </Box>

      <Table size="small" sx={{ '& td': { fontSize: '0.82rem' } }}>
        <TableHead>
          <TableRow sx={{ '& > *': { borderBottom: 'none', pb: 0 } }}>
            <TableCell sx={{ width: 150 }}>字段</TableCell>
            <TableCell>本机台账</TableCell>
            <TableCell>作坊离线包</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {record.fields.map((field) => (
            <FieldChoiceCell
              key={field.field}
              record={record}
              field={field.field}
              label={field.label}
              local={field.local}
              remote={field.remote}
            />
          ))}
        </TableBody>
      </Table>

      {record.status === 'conflict' && divergentFields.length > 0 && !record.applied && (
        <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mt: 0.5 }}>
          {divergentFields.length} 个字段取值不同：{divergentFields.map((field) => field.label).join('、')}；密度与偏差会在写入时按选中值重算。
        </Typography>
      )}
      {state.state === 'held' && (
        <Stack spacing={0.5} sx={{ mt: 0.5 }} data-testid={`held-${record.businessNo}`}>
          {record.missingUpstreams.map((reason) => (
            <Typography key={reason} variant="caption" color="warning.dark">· {reason}</Typography>
          ))}
        </Stack>
      )}
      {!record.applied && (
        <Typography variant="caption" color={state.state === 'ready' ? 'success.dark' : 'text.secondary'} sx={{ display: 'block', mt: 0.5 }}>
          {state.hint}
        </Typography>
      )}
      {record.applied && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{state.hint}</Typography>
      )}
    </Paper>
  )
}

const KIND_ORDER: ImportStagingRecord['kind'][] = ['mould', 'fiberBatch', 'sheetRun', 'paperSample']

export function StagingReview() {
  const staging = useImportStore((state) => state.staging)

  if (staging.length === 0) {
    return (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <Typography color="text.secondary">请选择上方一个批次，或读入新的离线包。</Typography>
        </CardContent>
      </Card>
    )
  }

  return (
    <Stack spacing={2.5} data-testid="staging-review">
      {KIND_ORDER.map((kind) => {
        const rows = staging.filter((record) => record.kind === kind)
        if (rows.length === 0) return null
        const appliedCount = rows.filter((record) => record.applied).length
        const heldCount = rows.filter((record) => !record.applied && record.missingUpstreams.length > 0).length
        return (
          <Card key={kind} data-testid={`group-${kind}`}>
            <CardContent sx={{ pb: '16px !important' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <Typography variant="h6">{kindLabel(kind)}</Typography>
                <Chip size="small" label={`${rows.length} 条`} />
                {appliedCount > 0 && <Chip size="small" color="success" variant="outlined" label={`已写入 ${appliedCount}`} />}
                {heldCount > 0 && <Chip size="small" color="warning" variant="outlined" label={`暂存 ${heldCount}`} />}
              </Box>
              <Stack spacing={1.25}>
                {rows.map((record) => (
                  <StagingCard key={record.key} record={record} />
                ))}
              </Stack>
              <Divider sx={{ mt: 2 }} />
            </CardContent>
          </Card>
        )
      })}
    </Stack>
  )
}
