'use strict';

const Homey = require('homey');

class IVTApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('IVT Anywhere app has been initialized');
  }

}

module.exports = IVTApp;
