import { Navigate, Route, Routes } from 'react-router-dom'
import Dashboard from '../pages/Dashboard'
import FiberBatchList from '../pages/FiberBatchList'
import ImportBridge from '../pages/ImportBridge'
import MouldLedger from '../pages/MouldLedger'
import RunBoard from '../pages/RunBoard'
import SampleCards from '../pages/SampleCards'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/moulds" element={<MouldLedger />} />
      <Route path="/fibers" element={<FiberBatchList />} />
      <Route path="/runs" element={<RunBoard />} />
      <Route path="/samples" element={<SampleCards />} />
      <Route path="/imports" element={<ImportBridge />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
