import React, { useEffect } from 'react';
import './App.css';
import { Redirect, Route, Switch, useLocation } from 'react-router-dom';

import Header from './parts/Header';
import Footer from './parts/Footer';

import Home from './pages/Home';
import Learn from './pages/Learn';
import Setup from './pages/Setup';
import Network from './pages/Network';
import Governance from './pages/Governance';
import Error from './pages/Error';

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
        <Route component={Error} />
      </Switch>
      <Footer />
    </div>
  );
}
