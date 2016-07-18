/**
 * Main entry class for Liquido
 * 
 * Here we initialize Vue, setup our URL-routing and register global Vue components.
 */
import Vue from 'vue'
import VueRouter from 'vue-router'
import VueResource from 'vue-resource'
import LiquidoHome from './controllers/LiquidoHome'
import Ideas from './controllers/Ideas'

// Register custom components
import LiquidoHeader from './components/LiquidoHeader'
import EditableCell from './components/EditableCell'
Vue.component('liquido-header', LiquidoHeader)
Vue.component('editable-cell', EditableCell)

// Vue plugins
Vue.use(VueResource);
Vue.use(VueRouter)
Vue.use(require('vue-model'))

// Vue components
//TODO: import Login from './components/Login'   see: https://auth0.com/blog/2015/11/13/build-an-app-with-vuejs/

// Setup Vue-router for navigation
var App = Vue.extend({})    // Keep in mind that 'App' is _not_ a Vue instance, but a Vue component!
var router = new VueRouter()
router.map({
    '/': {
        component: LiquidoHome
    },
    /*
    '/login': {
        component: Login
    }
    */
    '/ideas': {
        component: Ideas
    },
    '/userHome': {
        component: function(resolve) {    // asyncronously require component for lazy loading
          require(['./controllers/UserHome.vue'], resolve)
        }
    },
    '/proxies': {
        component: function(resolve) {    // asyncronously require component for lazy loading
          require(['./controllers/proxies.vue'], resolve)
        }
    }
})

// Start Vue app
router.start(App, '#app')
