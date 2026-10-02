import { useEffect, useMemo, useRef } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, Divider, LinearProgress, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material'
import { summarizeProgress, useImportStore } from '../stores/importStore'
import type { ImportBatchStatus, MergeConflict } from '../types/offline-package'
import { buildSampleOfflinePackage, FIELD_LABELS } from '../utils/merge'
import { exportOfflinePackageJson } from '../utils/export'

const STATUS_COLORS: Record<ImportBatchStatus, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  合并中: 'info',
  待选定: 'warning',
  部分合并: 'info',
  已合并: 'success',
  写入失败: 'error',
}

const ENTITY_LABELS: Record<string, string> = {
  mould: '纸帘',
  fiberBatch: '料批',
  sheetRun: '抄纸工序',
  paperSample: '成纸样本',
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  return String(value)
}

function ConflictCard({ conflict, onResolve }: { conflict: MergeConflict; onResolve: (side: '保留本机' | '采纳包内') => void }) {
  return (
    <Card data-testid="row-conflict" sx={{ borderColor: '#d9a928' }}>
      <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip size="small" color="warning" label={ENTITY_LABELS[conflict.entity] ?? conflict.entity} />
            <Typography sx={{ fontWeight: 800 }}>{conflict.bizNo}</Typography>
            <Typography variant="body2" color="text.secondary">{conflict.diffFields.length} 个字段有分歧，选定后才写入台账</Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" onClick={() => onResolve('保留本机')} data-testid={`resolve-local-${conflict.id ?? conflict.bizNo}`}>
              保留本机
            </Button>
            <Button size="small" variant="contained" onClick={() => onResolve('采纳包内')} data-testid={`resolve-incoming-${conflict.id ?? conflict.bizNo}`}>
              采纳包内
            </Button>
          </Box>
        </Box>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>字段</TableCell>
              <TableCell>本机台账</TableCell>
              <TableCell>包内数据</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {conflict.diffFields.map((field) => (
              <TableRow key={field}>
                <TableCell>{FIELD_LABELS[field] ?? field}</TableCell>
                <TableCell>{formatValue(conflict.localRecord[field])}</TableCell>
                <TableCell sx={{ color: 'warning.dark', fontWeight: 700 }}>{formatValue(conflict.incomingRecord[field])}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export default function ImportBridge() {
  const batches = useImportStore((state) => state.batches)
  const conflicts = useImportStore((state) => state.conflicts)
  const pendingLinks = useImportStore((state) => state.pendingLinks)
  const isMerging = useImportStore((state) => state.isMerging)
  const error = useImportStore((state) => state.error)
  const notice = useImportStore((state) => state.notice)
  const loadImportState = useImportStore((state) => state.loadImportState)
  const importPackageFile = useImportStore((state) => state.importPackageFile)
  const importSamplePackage = useImportStore((state) => state.importSamplePackage)
  const retryBatch = useImportStore((state) => state.retryBatch)
  const resolveConflict = useImportStore((state) => state.resolveConflict)
  const resolveAllConflicts = useImportStore((state) => state.resolveAllConflicts)
  const drainPendingLinks = useImportStore((state) => state.drainPendingLinks)
  const clearFeedback = useImportStore((state) => state.clearFeedback)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadImportState()
  }, [loadImportState])

  const openConflicts = useMemo(() => conflicts.filter((conflict) => conflict.status === '待选定'), [conflicts])
  const openPending = useMemo(() => pendingLinks.filter((link) => link.status === '待处理'), [pendingLinks])
  const batchNameById = useMemo(() => new Map(batches.map((batch) => [batch.id, batch.packageName])), [batches])

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importPackageFile(file)
    event.target.value = ''
  }

  const handleDownloadSample = () => {
    exportOfflinePackageJson(buildSampleOfflinePackage())
  }

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: { xs: 'flex-start', md: 'center' }, flexDirection: { xs: 'column', md: 'row' } }}>
        <Box>
          <Typography component="h1" variant="h3" color="#344a34">离线包合并</Typography>
          <Typography color="text.secondary" sx={{ mt: 0.75 }}>
            合并作坊带回的离线包：包内以业务编号认关系，同号分歧先留双方，缺上游的工序与样本暂存待处理。
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="contained" size="large" disabled={isMerging} onClick={() => fileInputRef.current?.click()} data-testid="pick-package">
            选择离线包
          </Button>
          <Button variant="outlined" size="large" disabled={isMerging} onClick={() => void importSamplePackage()} data-testid="import-sample-package">
            导入示例包
          </Button>
          <Button variant="text" size="large" onClick={handleDownloadSample} data-testid="download-sample-package">
            下载示例包
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={handleFileChange}
            data-testid="import-package-file"
          />
        </Box>
      </Box>

      {isMerging && <LinearProgress sx={{ borderRadius: 2 }} />}
      {error && <Alert severity="warning" onClose={clearFeedback}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={clearFeedback}>{notice}</Alert>}

      <Card>
        <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, mb: 1.5 }}>
            <Box>
              <Typography variant="h5">导入批次</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                同一包按包编号幂等：写入失败后批次与进度保留，重试不会重复建档。
              </Typography>
            </Box>
            <Chip label={`${batches.length} 个批次`} variant="outlined" />
          </Box>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 860 }}>
              <TableHead>
                <TableRow>
                  <TableCell>离线包</TableCell>
                  <TableCell>状态</TableCell>
                  <TableCell>合并进度</TableCell>
                  <TableCell>失败原因</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {batches.map((batch) => (
                  <TableRow key={batch.id ?? batch.packageId} data-testid="row-import-batch" hover>
                    <TableCell>
                      <Typography sx={{ fontWeight: 750 }}>{batch.packageName}</Typography>
                      <Typography variant="caption" color="text.secondary">{batch.packageId} · {formatTime(batch.importedAt)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" color={STATUS_COLORS[batch.status]} label={batch.status} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{summarizeProgress(batch.progress)}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        纸帘 {batch.progress.moulds.total} · 料批 {batch.progress.fiberBatches.total} · 工序 {batch.progress.sheetRuns.total} · 样本 {batch.progress.paperSamples.total}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="error">{batch.error ?? '—'}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      {batch.status === '写入失败' && batch.id !== undefined && (
                        <Button size="small" variant="contained" color="warning" disabled={isMerging} onClick={() => void retryBatch(batch.id as number)} data-testid={`retry-batch-${batch.id}`}>
                          重试
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {batches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4 }}>还没有导入过离线包</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        </CardContent>
      </Card>

      <Card>
        <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1.5 }}>
            <Box>
              <Typography variant="h5">同号分歧待选定</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                两边值都留底，选定一侧后才写入台账；关联工序与样本会跟着选中的上游重新挂接。
              </Typography>
            </Box>
            {openConflicts.length > 1 && (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button size="small" variant="outlined" onClick={() => void resolveAllConflicts('保留本机')} data-testid="resolve-all-local">全部保留本机</Button>
                <Button size="small" variant="outlined" color="warning" onClick={() => void resolveAllConflicts('采纳包内')} data-testid="resolve-all-incoming">全部采纳包内</Button>
              </Box>
            )}
          </Box>
          <Stack spacing={1.5}>
            {openConflicts.map((conflict) => (
              <ConflictCard
                key={conflict.id ?? `${conflict.entity}-${conflict.bizNo}`}
                conflict={conflict}
                onResolve={(side) => {
                  if (conflict.id !== undefined) void resolveConflict(conflict.id as number, side)
                }}
              />
            ))}
            {openConflicts.length === 0 && (
              <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>当前没有待选定的分歧</Typography>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1.5 }}>
            <Box>
              <Typography variant="h5">缺上游暂存</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                上游缺失或待选定的工序、样本先暂存；选定分歧或在台账补登记上游后，可重新挂接。
              </Typography>
            </Box>
            <Button size="small" variant="outlined" disabled={openPending.length === 0} onClick={() => void drainPendingLinks()} data-testid="drain-pending">
              重新挂接
            </Button>
          </Box>
          <Divider sx={{ mb: 1.5 }} />
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell>编号</TableCell>
                  <TableCell>类型</TableCell>
                  <TableCell>缺少的上游</TableCell>
                  <TableCell>来源批次</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {openPending.map((link) => (
                  <TableRow key={link.id ?? `${link.entity}-${link.bizNo}`} data-testid="row-pending" hover>
                    <TableCell sx={{ fontWeight: 700 }}>{link.bizNo}</TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" label={ENTITY_LABELS[link.entity] ?? link.entity} />
                    </TableCell>
                    <TableCell>{link.missing.join('、') || '—'}</TableCell>
                    <TableCell>{batchNameById.get(link.batchId) ?? `批次 ${link.batchId}`}</TableCell>
                  </TableRow>
                ))}
                {openPending.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} align="center" sx={{ py: 4 }}>当前没有暂存待处理的记录</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        </CardContent>
      </Card>
    </Stack>
  )
}
