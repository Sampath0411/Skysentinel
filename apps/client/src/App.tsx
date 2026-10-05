import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth, RequireRole, useAuth } from "./auth.js";
import { SYNTHETIC_BANNER } from "@skysentinel/shared";
import Login from "./components/Login.js";
import Home from "./components/Home.js";
import BriefScreen from "./components/BriefScreen.js";
import TraineeConsole from "./components/TraineeConsole.js";
import InstructorConsole from "./components/InstructorConsole.js";
import InstructorLive from "./components/InstructorLive.js";
import AarDashboard from "./components/AarDashboard.js";
import SessionDetail from "./components/SessionDetail.js";
import TraineeProfile from "./components/TraineeProfile.js";
import UnitView from "./components/UnitView.js";

const Header = () => {
  const { user, signOut } = useAuth();
  if (user === null) return null;
  return (
    <header className="app-header">
      <NavLink to="/" className="brand">
        SKYSENTINEL
      </NavLink>
      <nav>
        <NavLink to="/" end>
          Mission
        </NavLink>
        <NavLink to="/aar">After-Action Review</NavLink>
        <NavLink to="/profile">My Progress</NavLink>
        {(user.role === "instructor" || user.role === "admin") && (
          <>
            <NavLink to="/instructor">Instructor</NavLink>
            <NavLink to="/unit">Unit View</NavLink>
          </>
        )}
      </nav>
      <div className="who">
        <span className={`role-badge ${user.role}`}>{user.role}</span>
        <span>{user.display_name ?? user.username}</span>
        <button className="ghost small" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
};

export default function App() {
  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Home />
              </RequireAuth>
            }
          />
          <Route
            path="/brief/:sessionId"
            element={
              <RequireAuth>
                <BriefScreen />
              </RequireAuth>
            }
          />
          <Route
            path="/trainee/:sessionId"
            element={
              <RequireAuth>
                <TraineeConsole />
              </RequireAuth>
            }
          />
          <Route
            path="/instructor"
            element={
              <RequireRole roles={["instructor", "admin"]}>
                <InstructorConsole />
              </RequireRole>
            }
          />
          <Route
            path="/instructor/:sessionId"
            element={
              <RequireRole roles={["instructor", "admin"]}>
                <InstructorLive />
              </RequireRole>
            }
          />
          <Route
            path="/aar"
            element={
              <RequireAuth>
                <AarDashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/aar/:sessionId"
            element={
              <RequireAuth>
                <SessionDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <TraineeProfile />
              </RequireAuth>
            }
          />
          <Route
            path="/unit"
            element={
              <RequireRole roles={["instructor", "admin"]}>
                <UnitView />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="synthetic-banner">{SYNTHETIC_BANNER}</footer>
    </div>
  );
}
