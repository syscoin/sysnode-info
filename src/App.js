import React, { useEffect } from 'react';
import './App.css';
import { Redirect, Route, Switch, useLocation } from 'react-router-dom';

import Header from './parts/Header';
import Footer from './parts/Footer';
import PrivateRoute from './parts/PrivateRoute';

import Home from './pages/Home';
import Learn from './pages/Learn';
import Setup from './pages/Setup';
import Network from './pages/Network';
import Governance from './pages/Governance';
import Error from './pages/Error';
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import Account from './pages/Account';

import { AuthProvider } from './context/AuthContext';
import { VaultProvider } from './context/VaultContext';

function ScrollToTop() {
  const location = useLocation();

  useEffect(
    function scrollOnRouteChange() {
      window.scrollTo(0, 0);
    },
    [location.pathname]
  );

  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <VaultProvider>
        <div className="site-shell">
          <ScrollToTop />
          <Header />
          <Switch>
            <Route path="/" component={Home} exact />
            <Route path="/network" component={Network} />
            <Route path="/stats" render={() => <Redirect to="/network" />} />
            <Route path="/setup" component={Setup} />
            <Route path="/governance" component={Governance} />
            <Route path="/learn" component={Learn} />
            <Route path="/about" render={() => <Redirect to="/learn" />} />
            <Route path="/login" component={Login} />
            <Route path="/register" component={Register} />
            <Route path="/verify-email" component={VerifyEmail} />
            <PrivateRoute path="/account" component={Account} />
            <Route component={Error} />
          </Switch>
          <Footer />
        </div>
      </VaultProvider>
    </AuthProvider>
  );
}
