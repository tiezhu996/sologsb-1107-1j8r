import { useRef, useState } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from '@mui/material'
import { useImportStore } from '../../stores/importStore'

export function PackUploader() {
  const importFile = useImportStore((state) => state.importFile)
  const isBusy = useImportStore((state) => state.isBusy)
  const error = useImportStore((state) => state.error)
  const issues = useImportStore((state) => state.issues)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return
    const text = await file.text()
    await importFile(file.name, text)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <Card data-testid="pack-uploader" sx={{ border: dragging ? '2px dashed #5d7c5a' : '1px solid #d7ccb6', bgcolor: dragging ? '#eef3e8' : '#fffdf7' }}>
      <CardContent sx={{ p: { xs: 2, md: 3 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
          <Box>
            <Typography variant="h5">读入作坊离线包</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 620 }}>
              包内以纸帘、料批、工序、样本的业务编号认关系，本机数字编号不会被套用。同编号有分歧时先保留双方，选定后才写入台账。
            </Typography>
          </Box>
          <Chip color="primary" variant="outlined" label="gbpapermill-offline-pack/1" />
        </Box>
        <Box
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void handleFile(event.dataTransfer.files?.[0])
          }}
          sx={{ mt: 2, py: 3.5, border: '1px dashed #c3b597', borderRadius: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, bgcolor: '#faf6ec' }}
        >
          <Typography color="text.secondary">将离线包 JSON 拖到此处，或</Typography>
          <Button variant="contained" disabled={isBusy} onClick={() => inputRef.current?.click()} data-testid="choose-pack">
            选择离线包文件
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            hidden
            data-testid="pack-file-input"
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
        </Box>
        {error && <Alert severity="error" sx={{ mt: 2 }} data-testid="pack-error">{error}</Alert>}
        {issues.length > 0 && (
          <Stack spacing={1} sx={{ mt: 2 }} data-testid="pack-issues">
            <Typography variant="subtitle2" color="warning.dark">
              包内 {issues.length} 条记录未通过校验，已跳过；其余记录可正常核对：
            </Typography>
            {issues.slice(0, 8).map((issue, index) => (
              <Alert key={`${issue.kind}-${issue.businessNo}-${index}`} severity="warning">
                {issue.businessNo}：{issue.reason}
              </Alert>
            ))}
            {issues.length > 8 && <Typography variant="caption" color="text.secondary">其余 {issues.length - 8} 条问题省略显示</Typography>}
          </Stack>
        )}
      </CardContent>
    </Card>
  )
}
