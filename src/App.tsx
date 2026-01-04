import { Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Room from "./pages/Room";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:code" element={<Room />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
