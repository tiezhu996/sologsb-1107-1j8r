import { useEffect } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, Divider, Stack, Typography } from '@mui/material'
import { PackUploader } from '../components/import/PackUploader'
import { StagingReview } from '../components/import/StagingReview'
import { useFiberStore } from '../stores/fiberStore'
import { useImportStore } from '../stores/importStore'
import { useMouldStore } from '../stores/mouldStore'
import { useRunStore } from '../stores/runStore'
import { useSampleStore } from '../stores/sampleStore'
import type { ImportBatchRecord } from '../types/offline-pack'

const statusMeta: Record<ImportBatchRecord['status'], { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  review: { label: '待核对', color: 'default' },
  applying: { label: '写入中', color: 'info' },
  applied: { label: '已全部写入', color: 'success' },
  partial: { label: '部分写入', color: 'warning' },
  failed: { label: '写入失败已保留', color: 'error' },
}

function BatchListItem({ batch, selected, onSelect }: { batch: ImportBatchRecord; selected: boolean; onSelect: () => void }) {
  const discardBatch = useImportStore((state) => state.discardBatch)
  const isBusy = useImportStore((state) => state.isBusy)
  const meta = statusMeta[batch.status]
  return (
    <Card
      variant="outlined"
      data-testid={`batch-${batch.batchId.slice(0, 8)}`}
      onClick={onSelect}
      sx={{ cursor: 'pointer', borderColor: selected ? '#5d7c5a' : undefined, borderWidth: selected ? 2 : 1, bgcolor: selected ? '#f1f5ec' : undefined }}
    >
      <CardContent sx={{ p: 1.75, '&:last-child': { pb: 1.75 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontWeight: 750 }} noWrap>{batch.source}</Typography>
          <Chip size="small" color={meta.color} label={meta.label} />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }} noWrap>
          {batch.fileName ?? batch.batchId.slice(0, 12)}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
          <Chip size="small" variant="outlined" label={`共 ${batch.stats.total}`} />
          <Chip size="small" color="success" variant="outlined" label={`已写 ${batch.stats.applied}`} />
          {batch.stats.held > 0 && <Chip size="small" color="warning" variant="outlined" label={`暂存 ${batch.stats.held}`} />}
          {batch.stats.conflict > 0 && <Chip size="small" color="warning" variant="outlined" label={`分歧 ${batch.stats.conflict}`} />}
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1 }}>
          <Typography variant="caption" color="text.secondary">{batch.updatedAt.slice(0, 16).replace('T', ' ')}</Typography>
          <Button
            size="small"
            color="error"
            disabled={isBusy}
            onClick={(event) => {
              event.stopPropagation()
              void discardBatch(batch.batchId)
            }}
          >
            丢弃批次
          </Button>
        </Box>
      </CardContent>
    </Card>
  )
}

export default function ImportCenter() {
  const batches = useImportStore((state) => state.batches)
  const staging = useImportStore((state) => state.staging)
  const selectedBatchId = useImportStore((state) => state.selectedBatchId)
  const notice = useImportStore((state) => state.notice)
  const isBusy = useImportStore((state) => state.isBusy)
  const loadBatches = useImportStore((state) => state.loadBatches)
  const selectBatch = useImportStore((state) => state.selectBatch)
  const applyBatch = useImportStore((state) => state.applyBatch)

  const refreshMoulds = useMouldStore((state) => state.refreshMoulds)
  const refreshFiberBatches = useFiberStore((state) => state.refreshFiberBatches)
  const refreshRuns = useRunStore((state) => state.refreshRuns)
  const refreshSamples = useSampleStore((state) => state.refreshSamples)

  useEffect(() => {
    void loadBatches()
  }, [loadBatches])

  useEffect(() => {
    if (!selectedBatchId && batches.length > 0) {
      void selectBatch(batches[0].batchId)
    }
  }, [batches, selectedBatchId, selectBatch])

  const selectedBatch = batches.find((batch) => batch.batchId === selectedBatchId)
  const pending = staging.filter((record) => !record.applied)
  const unresolvedConflicts = pending.filter((record) => record.status === 'conflict' && !record.chosenSide && !record.fieldChoices).length
  const held = pending.filter((record) => record.missingUpstreams.length > 0).length
  const readyCount = pending.filter((record) => record.missingUpstreams.length === 0 && (record.status !== 'conflict' || record.chosenSide || record.fieldChoices)).length

  const refreshLedgers = () => {
    void refreshMoulds()
    void refreshFiberBatches()
    void refreshRuns()
    void refreshSamples()
  }

  const handleApply = async () => {
    if (!selectedBatchId) return
    const summary = await applyBatch(selectedBatchId)
    if (summary) refreshLedgers()
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography component="h1" variant="h3" color="#344a34">离线包合并</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.75 }}>
          读入作坊带回的离线包：业务编号认关系、双方分歧先留双方、下游跟随选中上游重新挂接；写入失败保留批次，重试不重复建档。
        </Typography>
      </Box>

      {notice && <Alert severity="info" data-testid="import-notice">{notice}</Alert>}

      <PackUploader />

      <Grid2Layout
        batches={batches}
        selectedBatchId={selectedBatchId}
        onSelect={(batchId) => void selectBatch(batchId)}
      />

      {selectedBatch && (
        <Card data-testid="batch-toolbar">
          <CardContent sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', py: '16px !important' }}>
            <Box sx={{ flex: 1, minWidth: 240 }}>
              <Typography variant="h6">{selectedBatch.source}</Typography>
              <Typography variant="body2" color="text.secondary">
                {selectedBatch.packedAt ? `打包于 ${selectedBatch.packedAt} · ` : ''}可写入 {readyCount} 条 · 待选定 {unresolvedConflicts} 条 · 缺上游暂存 {held} 条
              </Typography>
              {selectedBatch.error && <Typography variant="body2" color="error.main" sx={{ mt: 0.5 }}>上次写入遗留：{selectedBatch.error}</Typography>}
            </Box>
            <Button
              variant="contained"
              size="large"
              disabled={isBusy || pending.length === 0}
              onClick={() => void handleApply()}
              data-testid="apply-batch"
            >
              {selectedBatch.status === 'failed' || selectedBatch.status === 'partial' ? '按当前进度重试写入' : '写入台账'}
            </Button>
          </CardContent>
        </Card>
      )}

      <StagingReview />

      <Divider />
      <Typography variant="caption" color="text.secondary">
        说明：重试同一离线包会复用原批次与已写入进度，不会重复建档；纸帘密度与工序偏差按选中值重新推算；旧台账数据在首次打开新版时已回填版本号，现有台账与 JSON 导出均显示合并后的结果。
      </Typography>
    </Stack>
  )
}

function Grid2Layout({
  batches,
  selectedBatchId,
  onSelect,
}: {
  batches: ImportBatchRecord[]
  selectedBatchId: string | null
  onSelect: (batchId: string) => void
}) {
  if (batches.length === 0) return null
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }} data-testid="batch-list">
      {batches.map((batch) => (
        <BatchListItem key={batch.batchId} batch={batch} selected={batch.batchId === selectedBatchId} onSelect={() => onSelect(batch.batchId)} />
      ))}
    </Box>
  )
}
